/**
 * First-visit parity benchmark, orchestrator (stage S0 of docs/design/first-visit-parity.md).
 *
 * For each fixture size, CPU rate and network profile it runs the Kora app and the REST baseline
 * (alternating which goes first) on one production server process and database, in real
 * Chromium, timed from navigation start: a cold visit on a new profile (a new device), then, on
 * the same profile reopened, a warm visit. It prints the parity contract table (baseline, Kora,
 * limit, PASS or FAIL per metric and cell), the Kora-only targets K1 to K3, and the Kora cold
 * phase timeline that explains the cells, and writes every raw run as JSON.
 *
 * Run through `run.mjs` (it builds the apps and bundles this file); see README.md.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { type BrowserContext, type CDPSession, type Page, chromium } from 'playwright-core'
import type { CollectionDigest } from '../browser/digest'
import type { FixtureShape } from '../browser/fixture-server'
import { type Summary, summarize } from '../browser/stats'
import type { ParityEvent } from './apps/shared/parity-types'
import {
	K1_TARGET_MS,
	K3_BUDGET_BYTES,
	METRIC_LABELS,
	PARITY_METRICS,
	type ParityMetric,
	type Temperature,
	WARM_METRICS,
	evaluateCell,
	longestStall,
	totalBlockingTime,
} from './contract'
import { type ParityServer, type ParityTarget, startParityServer } from './parity-server'
import { type LinkConditions, startShapingProxy } from './shaping-proxy'

// ── Configuration ────────────────────────────────────────────────────────────────────────

const SIZES: Record<string, FixtureShape> = {
	small: { visibleOps: 2_000, tenants: 5, insertRate: 0.6, batchSize: 100, relations: true },
	'20k-1': { visibleOps: 20_000, tenants: 1, insertRate: 0.6, batchSize: 100, relations: true },
	'20k-5': { visibleOps: 20_000, tenants: 5, insertRate: 0.6, batchSize: 100, relations: true },
}

type AppName = 'kora' | 'baseline'
type ProfileName = 'slow-4g' | '4g' | 'broadband'

/** Design doc 2.3. `slow-4g` is the D8 preset (`throttleNetwork('slow-4g')`). */
const NETWORKS: Record<ProfileName, LinkConditions> = {
	'slow-4g': {
		rttMs: 150,
		downBytesPerSecond: (1.6 * 1024 * 1024) / 8,
		upBytesPerSecond: (750 * 1024) / 8,
	},
	'4g': { rttMs: 60, downBytesPerSecond: 9_000_000 / 8, upBytesPerSecond: 1_500_000 / 8 },
	broadband: { rttMs: 20, downBytesPerSecond: 50_000_000 / 8, upBytesPerSecond: 10_000_000 / 8 },
}

const list = (value: string | undefined, fallback: string): string[] =>
	(value ?? fallback)
		.split(',')
		.map((item) => item.trim())
		.filter((item) => item !== '')

const SIZE_NAMES = list(process.env.KORA_PARITY_SIZES, '20k-1')
const PROFILES = list(process.env.KORA_PARITY_PROFILES, 'slow-4g,4g,broadband') as ProfileName[]
const TEMPS = list(process.env.KORA_PARITY_TEMPS, 'cold,warm') as Temperature[]
const CPU_RATES = list(process.env.KORA_PARITY_CPU, '1,4').map(Number)
const RUNS = Number(process.env.KORA_PARITY_RUNS ?? 7)
const APPS = list(process.env.KORA_PARITY_APPS, 'baseline,kora') as AppName[]
/** `proxy` (default): one shared link for every connection. `cdp`: per-page CDP throttling. */
const THROTTLE = process.env.KORA_PARITY_THROTTLE === 'cdp' ? 'cdp' : 'proxy'
const OUTPUT_JSON = process.env.KORA_PARITY_JSON
const REPORT_FILES = list(process.env.KORA_PARITY_REPORT, '')
const STALE_OPS = Number(process.env.KORA_PARITY_STALE_OPS ?? 10_000)
/**
 * Diagnostic variants of the Kora cold visit (cause analysis, not part of the matrix):
 * `no-script` never opens a screen while the device prepares; `subsets-disabled` runs the
 * Kora app with `sync.querySubsets.mode = 'disabled'`.
 */
const DIAG = process.env.KORA_PARITY_DIAG ?? ''

/** How long one scripted step may take before it is recorded as a timeout. */
const STEP_TIMEOUT_MS = Number(process.env.KORA_PARITY_STEP_TIMEOUT_MS ?? 90_000)
/** Kora's cold run waits this long (from navigation) for `offline.status()` ready (S0: 300 s). */
const READY_TIMEOUT_MS = Number(process.env.KORA_PARITY_READY_TIMEOUT_MS ?? 300_000)
/** P8 window: navigation to 30 s. */
const TBT_WINDOW_MS = 30_000

const log = (message: string): void => {
	console.error(`[parity] ${message}`)
}

// ── Raw results ──────────────────────────────────────────────────────────────────────────

/** One scripted pass over the screens: latencies from click to the awaited row, ms. */
interface PassResult {
	course: number | null
	lesson: number | null
	write: number | null
	home: number | null
}

interface VisitResult {
	app: AppName
	temperature: Temperature
	/** First paint of the app shell (P1); FCP of whatever painted first is kept apart. */
	appPaint: number | null
	fcp: number | null
	firstData: number | null
	complete: number | null
	/** First pass. On a cold Kora run it runs while Kora prepares for offline (P7). */
	pass1: PassResult | null
	/** Second pass, on screens never opened before (Kora: after offline-ready). */
	pass2: PassResult | null
	/** Kora: offline-ready (K1) from navigation. */
	offlineReady: number | null
	tbt30s: number
	/** Longest main-thread stall between first data and offline-ready (K2), Kora cold only. */
	prepLongestStall: number | null
	prepStalls: number | null
	bytesBeforeFirstData: number | null
	bytesTotal: number
	/** Kora cold: every device collection equals the server's (null when not checked). */
	digestMatch: boolean | null
	digestMismatches: string[]
	events: ParityEvent[]
	/** The page's resource timings (requests the page and its dedicated workers' scripts made). */
	resources: Array<{ name: string; start: number; end: number; bytes: number }>
	errors: string[]
}

interface RunRecord {
	size: string
	cpu: number
	profile: ProfileName
	run: number
	/** 1-minute load average when the run started (the host may be shared). */
	loadAverage: number
	visits: VisitResult[]
}

interface Report {
	host: Record<string, unknown>
	commit: string
	throttle: string
	criticalJsGzip: Record<AppName, number>
	runs: RunRecord[]
}

// ── Page helpers ─────────────────────────────────────────────────────────────────────────

interface EventQuery {
	name: string
	screen?: string
	after: number
	prefix?: boolean
}

/** Wait (polling the page) for the first probe event matching `query`; null on timeout. */
async function waitEvent(page: Page, query: EventQuery, timeoutMs: number): Promise<number | null> {
	try {
		const handle = await page.waitForFunction(
			(q) => {
				const events = window.__parity?.events ?? []
				const hit = events.find(
					(event) =>
						(q.prefix === true ? event.name.startsWith(q.name) : event.name === q.name) &&
						(q.screen === undefined || event.screen === q.screen) &&
						event.t >= q.after,
				)
				return hit === undefined ? false : hit.t
			},
			query,
			{ timeout: timeoutMs, polling: 50 },
		)
		const value: unknown = await handle.jsonValue()
		return typeof value === 'number' ? value : null
	} catch (error) {
		if (error instanceof Error && error.name === 'TimeoutError') return null
		throw error
	}
}

const pageNow = (page: Page): Promise<number> => page.evaluate(() => performance.now())

/**
 * Click `action` on `id` and time it, from the click event's timestamp to the probe event
 * `until`. Null when the element never appeared or the result never came.
 */
async function timedClick(
	page: Page,
	action: string,
	id: string | null,
	until: { name: string; screen: string },
	errors: string[],
): Promise<number | null> {
	const selector =
		id === null ? `[data-action="${action}"]` : `[data-action="${action}"][data-id="${id}"]`
	const before = await pageNow(page)
	try {
		await page.click(selector, { timeout: STEP_TIMEOUT_MS })
	} catch (error) {
		errors.push(
			`${action} ${id ?? ''}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
		)
		return null
	}
	const clickedAt = await waitEvent(page, { name: 'click', screen: action, after: before }, 10_000)
	if (clickedAt === null) {
		errors.push(`${action}: click not recorded`)
		return null
	}
	const doneAt = await waitEvent(page, { ...until, after: clickedAt }, STEP_TIMEOUT_MS)
	if (doneAt === null) {
		errors.push(
			`${action} ${id ?? ''}: no ${until.name} on ${until.screen} in ${STEP_TIMEOUT_MS} ms`,
		)
		return null
	}
	return doneAt - clickedAt
}

/** Home, course, lesson, "Mark done", Home: the S0 script. Stops at the first missing step. */
async function scriptPass(page: Page, target: ParityTarget, errors: string[]): Promise<PassResult> {
	const result: PassResult = { course: null, lesson: null, write: null, home: null }
	result.course = await timedClick(
		page,
		'open-home',
		target.courseId,
		{ name: 'first-row', screen: 'course' },
		errors,
	)
	if (result.course === null) return result
	result.lesson = await timedClick(
		page,
		'open-course',
		target.lessonId,
		{ name: 'first-row', screen: 'lesson' },
		errors,
	)
	if (result.lesson === null) return result
	result.write = await timedClick(
		page,
		'mark-done',
		null,
		{ name: 'row-added', screen: 'progress' },
		errors,
	)
	result.home = await timedClick(page, 'home', null, { name: 'first-row', screen: 'home' }, errors)
	return result
}

interface Session {
	context: BrowserContext
	page: Page
	cdp: CDPSession
}

async function openSession(
	profileDir: string,
	network: LinkConditions,
	cpu: number,
	initScript: string,
): Promise<Session> {
	const context = await chromium.launchPersistentContext(profileDir, {
		executablePath: process.env.PW_CHROMIUM_PATH || undefined,
		args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
	})
	await context.addInitScript({ content: initScript })
	const page = context.pages()[0] ?? (await context.newPage())
	const cdp = await context.newCDPSession(page)
	if (THROTTLE === 'cdp') {
		await cdp.send('Network.enable')
		await cdp.send('Network.emulateNetworkConditions', {
			offline: false,
			latency: network.rttMs,
			downloadThroughput: network.downBytesPerSecond,
			uploadThroughput: network.upBytesPerSecond,
		})
	}
	if (cpu !== 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu })
	return { context, page, cdp }
}

interface VisitPlan {
	app: AppName
	temperature: Temperature
	origin: string
	targets: { first: ParityTarget; second: ParityTarget | null }
	/** Run the scripted passes (the warm-stale cell only loads the home screen). */
	script: boolean
	/** Kora cold: wait for offline-ready between the passes and check the digest. */
	koraCold: boolean
	server: ParityServer
}

/** Navigate and run one visit; the page is throttled before navigation. */
async function visit(
	session: Session,
	plan: VisitPlan,
	proxy: {
		downBytesBetween(a: number, b: number): number
		downBytesTotal(): number
		reset(): void
	},
): Promise<VisitResult> {
	const { page } = session
	const errors: string[] = []
	page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
	proxy.reset()
	await page.goto(`${plan.origin}/${plan.app}/`, { waitUntil: 'commit' })
	const timeOrigin = await page.evaluate(() => performance.timeOrigin)

	const firstData = await waitEvent(page, { name: 'first-row', screen: 'home', after: 0 }, 120_000)
	if (firstData === null) errors.push('home: no first row in 120 s')

	// The first pass starts at first data (on a cold Kora device: while it prepares, P7), not
	// after the home screen is complete, which on Kora can take the whole first sync.
	const pass1 =
		firstData === null || !plan.script ? null : await scriptPass(page, plan.targets.first, errors)

	let offlineReady: number | null = null
	let digestMatch: boolean | null = null
	const digestMismatches: string[] = []
	if (plan.koraCold && firstData !== null) {
		const remaining = Math.max(1_000, READY_TIMEOUT_MS - (await pageNow(page)))
		offlineReady = await waitEvent(page, { name: 'kora:offline-ready', after: 0 }, remaining)
		if (offlineReady === null) {
			const reasons = await page.evaluate(() => window.__parityKora?.offlineReasons() ?? [])
			errors.push(`not offline-ready in ${READY_TIMEOUT_MS} ms: ${reasons.join(', ')}`)
		} else {
			// Correctness: once uploads settle, the device holds the server's rows.
			await page
				.waitForFunction(() => window.__parityKora?.pendingOperations() === 0, undefined, {
					timeout: 30_000,
					polling: 100,
				})
				.catch(() => errors.push('uploads did not settle in 30 s'))
			const want = await plan.server.digests()
			const got: Record<string, CollectionDigest> = await page.evaluate(
				(collections) => window.__parityKora?.digest(collections) ?? Promise.resolve({}),
				Object.keys(want),
			)
			for (const [collection, digest] of Object.entries(want)) {
				const mine = got[collection]
				if (mine === undefined || mine.count !== digest.count || mine.sum !== digest.sum) {
					digestMismatches.push(
						`${collection} (device ${mine?.count ?? 0}, server ${digest.count})`,
					)
				}
			}
			digestMatch = digestMismatches.length === 0
		}
	}

	// A pass that stopped early leaves another screen open: return home (untimed).
	if (pass1 !== null && pass1.home === null) {
		await page.click('[data-action="home"]:not([disabled])', { timeout: 5_000 }).catch(() => {})
	}

	// P3: the first moment of the visit the home list equals the server's rows (on whichever
	// mount of the home screen: the first pass may have left and re-entered it).
	const completeBudget =
		plan.koraCold || plan.temperature === 'warm-stale' ? READY_TIMEOUT_MS : STEP_TIMEOUT_MS * 2
	const complete =
		firstData === null
			? null
			: await waitEvent(
					page,
					{ name: 'complete', screen: 'home', after: 0 },
					Math.max(1_000, completeBudget - (await pageNow(page))),
				)
	if (firstData !== null && complete === null) errors.push('home: never equal to the server rows')

	const pass2 =
		plan.targets.second === null || firstData === null || !plan.script
			? null
			: await scriptPass(page, plan.targets.second, errors)

	// P8 covers navigation to 30 s: let the window close before reading it.
	await page
		.waitForFunction((end) => performance.now() >= end, TBT_WINDOW_MS, {
			timeout: TBT_WINDOW_MS + 10_000,
			polling: 250,
		})
		.catch(() => errors.push('P8 window did not close'))
	const probe = await page.evaluate(() => {
		const p = window.__parity
		return {
			events: p?.events ?? [],
			stalls: p?.stalls ?? [],
			fcp: p?.fcp ?? null,
			shellPaint: p?.shellPaint ?? null,
			resources: performance.getEntriesByType('resource').map((entry) => ({
				name: new URL(entry.name).pathname,
				start: entry.startTime,
				end: (entry as PerformanceResourceTiming).responseEnd,
				bytes: (entry as PerformanceResourceTiming).transferSize,
			})),
		}
	})
	const shellMounted = probe.events.find((event) => event.name === 'shell-mounted')?.t ?? null
	const prepEnd = offlineReady ?? (await pageNow(page))
	return {
		app: plan.app,
		temperature: plan.temperature,
		appPaint: probe.shellPaint ?? shellMounted,
		fcp: probe.fcp,
		firstData,
		complete,
		pass1,
		pass2,
		offlineReady,
		tbt30s: totalBlockingTime(probe.stalls, 0, TBT_WINDOW_MS),
		prepLongestStall:
			plan.koraCold && firstData !== null ? longestStall(probe.stalls, firstData, prepEnd) : null,
		prepStalls:
			plan.koraCold && firstData !== null
				? probe.stalls.filter(([start]) => start >= firstData && start < prepEnd).length
				: null,
		bytesBeforeFirstData:
			firstData === null || THROTTLE !== 'proxy'
				? null
				: proxy.downBytesBetween(0, timeOrigin + firstData),
		bytesTotal: proxy.downBytesTotal(),
		digestMatch,
		digestMismatches,
		events: probe.events,
		resources: probe.resources,
		errors,
	}
}

function initScript(token: string, school: string, expectHome: Array<[string, string]>): string {
	const config = JSON.stringify({
		school,
		expectHome,
		subsets: DIAG === 'subsets-disabled' ? 'disabled' : undefined,
	})
	return `try { localStorage.setItem('parity-token', ${JSON.stringify(token)}) } catch {}\nwindow.__parityConfig = ${config}`
}

/** One app, one run: cold on a new profile, then warm on the same profile reopened. */
async function coldAndWarm(
	app: AppName,
	cpu: number,
	profile: ProfileName,
	server: ParityServer,
	origin: string,
	targets: ParityTarget[],
	proxy: Awaited<ReturnType<typeof startShapingProxy>>,
	runIndex: number,
): Promise<VisitResult[]> {
	const [a, b, c] = targets
	if (a === undefined || b === undefined || c === undefined) throw new Error('three targets needed')
	const profileDir = mkdtempSync(join(tmpdir(), `kora-parity-${app}-`))
	const token = `parity-${app}-${profile}-${cpu}x-${runIndex}-${Date.now()}`
	const expectHome = await server.homeRows()
	const script = initScript(token, server.meta.school, expectHome)
	const network = NETWORKS[profile]
	const results: VisitResult[] = []
	proxy.setConditions(THROTTLE === 'proxy' ? network : null)
	try {
		if (TEMPS.includes('cold') || TEMPS.includes('warm')) {
			const session = await openSession(profileDir, network, cpu, script)
			try {
				const cold = await visit(
					session,
					{
						app,
						temperature: 'cold',
						origin,
						targets: { first: a, second: b },
						script: !(DIAG === 'no-script' && app === 'kora'),
						koraCold: app === 'kora',
						server,
					},
					proxy,
				)
				results.push(cold)
				log(describeVisit(cold))
			} finally {
				await session.context.close()
			}
		}
		if (TEMPS.includes('warm')) {
			const session = await openSession(profileDir, network, cpu, script)
			try {
				const warm = await visit(
					session,
					{
						app,
						temperature: 'warm',
						origin,
						targets: { first: c, second: null },
						script: true,
						koraCold: false,
						server,
					},
					proxy,
				)
				results.push(warm)
				log(describeVisit(warm))
			} finally {
				await session.context.close()
			}
		}
	} finally {
		rmSync(profileDir, { recursive: true, force: true })
	}
	return TEMPS.includes('cold') ? results : results.filter((r) => r.temperature !== 'cold')
}

/**
 * The warm-stale cell (S0 "Warm-stale cell"): a device that finished a first session (Kora:
 * offline-ready, prepared unthrottled and untimed), then the server's log grows by
 * `STALE_OPS` operations, then the device returns on the profile. P2 is the first (possibly
 * stale) row; P3 is the moment the screen shows the server's current rows.
 */
async function warmStale(
	app: AppName,
	cpu: number,
	profile: ProfileName,
	shape: FixtureShape,
	staticDir: string,
	runIndex: number,
): Promise<VisitResult> {
	const runDirectory = mkdtempSync(join(tmpdir(), 'kora-parity-stale-'))
	const server = await startParityServer(shape, runDirectory, staticDir, log)
	const proxy = await startShapingProxy(Number(new URL(server.origin).port))
	const origin = `http://127.0.0.1:${proxy.port}`
	const profileDir = mkdtempSync(join(tmpdir(), `kora-parity-stale-${app}-`))
	const token = `parity-stale-${app}-${profile}-${cpu}x-${runIndex}-${Date.now()}`
	try {
		const before = await server.homeRows()
		proxy.setConditions(null)
		const prep = await openSession(
			profileDir,
			NETWORKS.broadband,
			1,
			initScript(token, server.meta.school, before),
		)
		try {
			await prep.page.goto(`${origin}/${app}/`, { waitUntil: 'commit' })
			const ready =
				app === 'kora'
					? await waitEvent(prep.page, { name: 'kora:offline-ready', after: 0 }, 600_000)
					: await waitEvent(prep.page, { name: 'complete', screen: 'home', after: 0 }, 60_000)
			if (ready === null) throw new Error(`warm-stale ${app}: the first session never finished`)
		} finally {
			await prep.context.close()
		}
		const started = performance.now()
		await server.grow(STALE_OPS)
		log(
			`warm-stale: server grew by ${STALE_OPS} operations in ${Math.round(performance.now() - started)} ms`,
		)
		const after = await server.homeRows()
		proxy.setConditions(THROTTLE === 'proxy' ? NETWORKS[profile] : null)
		const session = await openSession(
			profileDir,
			NETWORKS[profile],
			cpu,
			initScript(token, server.meta.school, after),
		)
		try {
			const result = await visit(
				session,
				{
					app,
					temperature: 'warm-stale',
					origin,
					targets: { first: { courseId: '', lessonId: '' }, second: null },
					script: false,
					koraCold: false,
					server,
				},
				proxy,
			)
			log(describeVisit(result))
			return result
		} finally {
			await session.context.close()
		}
	} finally {
		rmSync(profileDir, { recursive: true, force: true })
		await proxy.close()
		await server.stop()
		rmSync(runDirectory, { recursive: true, force: true })
	}
}

// ── Metrics and output ───────────────────────────────────────────────────────────────────

const fmt = (ms: number | null): string =>
	ms === null ? 'timeout' : Number.isFinite(ms) ? `${Math.round(ms)}` : 'timeout'

function describeVisit(v: VisitResult): string {
	const pass = (p: PassResult | null): string =>
		p === null
			? 'n/a'
			: `course ${fmt(p.course)}, lesson ${fmt(p.lesson)}, write ${fmt(p.write)}, home ${fmt(p.home)}`
	const storage = v.events.find((e) => e.name.startsWith('kora:storage:'))?.name.slice(13)
	return `${v.app} ${v.temperature}${storage === undefined ? '' : ` [${storage}]`}: paint ${fmt(v.appPaint)}, first data ${fmt(v.firstData)}, complete ${fmt(v.complete)}; pass1 [${pass(v.pass1)}]; pass2 [${pass(v.pass2)}]; ready ${fmt(v.offlineReady)}; TBT ${Math.round(v.tbt30s)}; KiB before data ${v.bytesBeforeFirstData === null ? 'n/a' : Math.round(v.bytesBeforeFirstData / 1024)}; digest ${v.digestMatch === null ? 'n/a' : v.digestMatch ? 'ok' : `MISMATCH ${v.digestMismatches.join(', ')}`}${v.errors.length > 0 ? `; errors: ${v.errors.join(' | ')}` : ''}`
}

/** The value of `metric` in one visit (null: timed out or not applicable). */
function metricValue(v: VisitResult, metric: ParityMetric): number | null {
	// Cold: P4 to P6 come from the second pass (Kora: after offline-ready), P7 from the first
	// (Kora: while preparing). Warm and warm-stale: the only pass.
	const settled = v.temperature === 'cold' ? v.pass2 : v.pass1
	switch (metric) {
		case 'P1':
			return v.appPaint
		case 'P2':
			return v.firstData
		case 'P3':
			return v.complete
		case 'P4-course':
			return settled?.course ?? null
		case 'P4-lesson':
			return settled?.lesson ?? null
		case 'P5':
			return settled?.home ?? null
		case 'P6':
			return settled?.write ?? null
		case 'P7-course':
			return v.pass1?.course ?? null
		case 'P7-lesson':
			return v.pass1?.lesson ?? null
		case 'P7-write':
			return v.pass1?.write ?? null
		case 'P8':
			return v.tbt30s
		case 'P9':
			return v.bytesBeforeFirstData === null ? null : v.bytesBeforeFirstData / 1024
	}
}

function metricsFor(temperature: Temperature): readonly ParityMetric[] {
	if (temperature === 'cold') return PARITY_METRICS
	if (temperature === 'warm') return WARM_METRICS
	return ['P1', 'P2', 'P3', 'P8', 'P9']
}

const showMs = (value: number): string =>
	Number.isFinite(value)
		? value >= 10_000
			? `${(value / 1000).toFixed(1)} s`
			: `${Math.round(value)} ms`
		: 'timeout'
const showValue = (metric: ParityMetric, value: number): string =>
	metric === 'P9' ? (Number.isFinite(value) ? `${Math.round(value)} KiB` : 'n/a') : showMs(value)
const pair = (metric: ParityMetric, s: Summary): string =>
	`${showValue(metric, s.median)} / ${showValue(metric, s.p95)}`

interface CellRow {
	key: string
	size: string
	cpu: number
	profile: ProfileName
	temperature: Temperature
	metric: ParityMetric
	line: string
	pass: boolean
}

function contractRows(report: Report): CellRow[] {
	const rows: CellRow[] = []
	const groups = new Map<string, RunRecord[]>()
	for (const run of report.runs) {
		const key = `${run.size}|${run.cpu}|${run.profile}`
		groups.set(key, [...(groups.get(key) ?? []), run])
	}
	for (const [key, runs] of groups) {
		const first = runs[0]
		if (first === undefined) continue
		const visits = runs.flatMap((run) => run.visits)
		for (const temperature of ['cold', 'warm', 'warm-stale'] as const) {
			const of = (app: AppName): VisitResult[] =>
				visits.filter((v) => v.app === app && v.temperature === temperature)
			const baseline = of('baseline')
			const kora = of('kora')
			if (baseline.length === 0 || kora.length === 0) continue
			for (const metric of metricsFor(temperature)) {
				const verdict = evaluateCell(
					metric,
					temperature,
					baseline.map((v) => metricValue(v, metric)),
					kora.map((v) => metricValue(v, metric)),
				)
				const overP50 = verdict.kora.median - verdict.limitP50
				const overP95 = verdict.kora.p95 - verdict.limitP95
				const over = (value: number): string =>
					Number.isFinite(value)
						? `${value > 0 ? '+' : ''}${metric === 'P9' ? `${Math.round(value)} KiB` : showMs(value)}`
						: 'n/a'
				rows.push({
					key,
					size: first.size,
					cpu: first.cpu,
					profile: first.profile,
					temperature,
					metric,
					pass: verdict.pass,
					line: `| ${METRIC_LABELS[metric]} | ${first.profile} | ${temperature} | ${first.cpu}x | ${pair(metric, verdict.baseline)} | ${pair(metric, verdict.kora)} | ${showValue(metric, verdict.limitP50)} / ${showValue(metric, verdict.limitP95)} | ${over(overP50)} / ${over(overP95)} | ${verdict.pass ? 'PASS' : 'FAIL'} |`,
				})
			}
		}
	}
	return rows
}

function koraTargets(report: Report): string[] {
	const lines: string[] = [
		'| Target | Network | CPU | Kora p50 / p95 | Target | Result |',
		'|---|---|---|---|---|---|',
	]
	const groups = new Map<string, RunRecord[]>()
	for (const run of report.runs) {
		const key = `${run.size}|${run.cpu}|${run.profile}`
		groups.set(key, [...(groups.get(key) ?? []), run])
	}
	for (const runs of groups.values()) {
		const first = runs[0]
		if (first === undefined) continue
		const cold = runs
			.flatMap((run) => run.visits)
			.filter((v) => v.app === 'kora' && v.temperature === 'cold')
		if (cold.length === 0) continue
		const ready = summarize(cold.map((v) => v.offlineReady ?? Number.POSITIVE_INFINITY))
		const target = K1_TARGET_MS[first.profile] ?? Number.POSITIVE_INFINITY
		lines.push(
			`| K1 offline-ready (${first.size}) | ${first.profile} | ${first.cpu}x | ${showMs(ready.median)} / ${showMs(ready.p95)} | ${showMs(target)} | ${ready.p95 <= target ? 'PASS' : 'FAIL'} |`,
		)
		const stall = summarize(cold.map((v) => v.prepLongestStall ?? 0))
		const count = summarize(cold.map((v) => v.prepStalls ?? 0))
		lines.push(
			`| K2 longest main-thread task while preparing (stalls over 50 ms: ${Math.round(count.median)} median) | ${first.profile} | ${first.cpu}x | ${showMs(stall.median)} / ${showMs(stall.p95)} | 50 ms | ${stall.p95 <= 50 ? 'PASS' : 'FAIL'} |`,
		)
	}
	const added = report.criticalJsGzip.kora - report.criticalJsGzip.baseline
	lines.push(
		`| K3 critical-path JS over the baseline (gzip) | all | all | ${(added / 1024).toFixed(1)} KiB (Kora ${(report.criticalJsGzip.kora / 1024).toFixed(1)}, baseline ${(report.criticalJsGzip.baseline / 1024).toFixed(1)}) | ${K3_BUDGET_BYTES / 1024} KiB | ${added <= K3_BUDGET_BYTES ? 'PASS' : 'FAIL'} |`,
	)
	return lines
}

/** Median page time of each Kora cold phase: the measured causes behind the cells. */
function koraPhases(report: Report): string[] {
	const PHASES: Array<[string, (v: VisitResult) => number | null]> = [
		['entry chunk downloaded', (v) => resourceEnd(v, /\/assets\/index-[^/]+\.js$/, 'largest')],
		['entry chunk evaluated (`kora:entry`)', (v) => at(v.events, 'kora:entry')],
		['provider fallback shown', (v) => at(v.events, 'fallback-mounted')],
		['worker script downloaded', (v) => resourceEnd(v, /kora-worker-[^/]+\.js$/, 'first')],
		['WASM download starts (worker)', (v) => at(v.events, 'worker:wasm-fetch-start')],
		['WASM downloaded (worker)', (v) => at(v.events, 'worker:wasm-fetched')],
		['WASM compiled and instantiated (worker)', (v) => at(v.events, 'worker:wasm-instantiated')],
		['store open (`app.ready`: OPFS open, DDL)', (v) => at(v.events, 'kora:ready')],
		['app shell mounted (provider stops gating)', (v) => at(v.events, 'shell-mounted')],
		['WebSocket requested (`connect()`)', (v) => at(v.events, 'ws:open-requested')],
		['handshake response', (v) => at(v.events, 'ws:handshake-response')],
		['first operation batch applied', (v) => at(v.events, 'kora:first-batch')],
		['first home row (P2)', (v) => at(v.events, 'first-row', 'home')],
		['home equals the server (P3)', (v) => at(v.events, 'complete', 'home')],
		['service worker shell installed', (v) => atPrefix(v.events, 'offline:', 'shell=installed')],
		['offline-ready (K1)', (v) => at(v.events, 'kora:offline-ready')],
	]
	const lines: string[] = [
		`| Phase (Kora, cold, ms from navigation, median) | ${[...new Set(report.runs.map((r) => `${r.profile} ${r.cpu}x`))].join(' | ')} |`,
	]
	const columns = [...new Set(report.runs.map((r) => `${r.profile}|${r.cpu}`))]
	lines.push(`|---|${columns.map(() => '---').join('|')}|`)
	for (const [label, pick] of PHASES) {
		const cells = columns.map((column) => {
			const [profile, cpu] = column.split('|')
			const values = report.runs
				.filter((r) => r.profile === profile && String(r.cpu) === cpu)
				.flatMap((r) => r.visits)
				.filter((v) => v.app === 'kora' && v.temperature === 'cold')
				.map((v) => pick(v))
				.filter((value): value is number => value !== null)
			return values.length === 0 ? 'n/a' : showMs(summarize(values).median)
		})
		lines.push(`| ${label} | ${cells.join(' | ')} |`)
	}
	return lines
}

function at(events: ParityEvent[], name: string, screen?: string): number | null {
	return (
		events.find((e) => e.name === name && (screen === undefined || e.screen === screen))?.t ?? null
	)
}

/** End of the matching resource (the largest, or the first started). */
function resourceEnd(v: VisitResult, pattern: RegExp, which: 'largest' | 'first'): number | null {
	const matching = v.resources.filter((r) => pattern.test(r.name))
	if (matching.length === 0) return null
	const pick =
		which === 'largest'
			? matching.reduce((a, b) => (b.bytes > a.bytes ? b : a))
			: matching.reduce((a, b) => (b.start < a.start ? b : a))
	return pick.end
}

function atPrefix(events: ParityEvent[], prefix: string, contains: string): number | null {
	return events.find((e) => e.name.startsWith(prefix) && e.name.includes(contains))?.t ?? null
}

function printReport(report: Report): void {
	const rows = contractRows(report)
	console.log(`\nHost: ${JSON.stringify(report.host)}`)
	console.log(`Commit: ${report.commit}; network shaping: ${report.throttle}`)
	console.log(
		'Median / p95 over the runs (nearest rank; the maximum at 7 runs). Limit: the contract (section 2.4). Over: Kora minus the limit (negative is headroom).\n',
	)
	const bySize = new Map<string, CellRow[]>()
	for (const row of rows) bySize.set(row.size, [...(bySize.get(row.size) ?? []), row])
	for (const [size, sizeRows] of bySize) {
		console.log(`### Fixture ${size}\n`)
		console.log(
			'| Metric | Network | Temp | CPU | Baseline p50 / p95 | Kora p50 / p95 | Limit p50 / p95 | Over p50 / p95 | Result |',
		)
		console.log('|---|---|---|---|---|---|---|---|---|')
		const order = (row: CellRow): string =>
			`${row.cpu}|${['slow-4g', '4g', 'broadband'].indexOf(row.profile)}|${['cold', 'warm', 'warm-stale'].indexOf(row.temperature)}|${PARITY_METRICS.indexOf(row.metric).toString().padStart(2, '0')}`
		for (const row of [...sizeRows].sort((x, y) => (order(x) < order(y) ? -1 : 1)))
			console.log(row.line)
		const passed = sizeRows.filter((row) => row.pass).length
		console.log(`\n${passed} of ${sizeRows.length} cells pass.\n`)
	}
	console.log('### Kora-only targets\n')
	console.log(koraTargets(report).join('\n'))
	console.log('\n### Kora cold phases (causes)\n')
	console.log(koraPhases(report).join('\n'))
	const storages = new Map<string, number>()
	for (const v of report.runs.flatMap((r) => r.visits)) {
		const storage = v.events.find((e) => e.name.startsWith('kora:storage:'))?.name.slice(13)
		if (storage !== undefined) storages.set(storage, (storages.get(storage) ?? 0) + 1)
	}
	const loads = summarize(report.runs.map((r) => r.loadAverage))
	console.log(
		`\nHost 1-minute load average at run start: median ${loads.median.toFixed(2)}, max ${loads.max.toFixed(2)} (${report.host.cpus} CPUs)`,
	)
	console.log(`Kora storage backends: ${JSON.stringify(Object.fromEntries(storages))}`)
	const mismatches = report.runs.flatMap((r) => r.visits).filter((v) => v.digestMatch === false)
	if (mismatches.length > 0) {
		console.log(`\nCORRECTNESS: ${mismatches.length} Kora run(s) did not match the server's rows.`)
	}
}

// ── Build facts ──────────────────────────────────────────────────────────────────────────

/** Gzip bytes of the JavaScript an app's `index.html` loads before it can render (K3). */
function criticalJsGzip(appDir: string): number {
	const html = readFileSync(join(appDir, 'index.html'), 'utf8')
	const urls = new Set<string>()
	for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) if (match[1]) urls.add(match[1])
	for (const match of html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)) {
		if (match[1]) urls.add(match[1])
	}
	let total = 0
	for (const url of urls) {
		const file = join(appDir, url.replace(/^\/[^/]+\//, ''))
		total += gzipSync(readFileSync(file), { level: 9 }).length
	}
	// Inline scripts (the probe, identical in both apps) count too.
	for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
		total += gzipSync(Buffer.from(match[1] ?? ''), { level: 9 }).length
	}
	return total
}

function gitCommit(): string {
	try {
		return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
	} catch {
		return 'unknown'
	}
}

// ── Main ─────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	if (REPORT_FILES.length > 0) {
		const reports = REPORT_FILES.map((file) => JSON.parse(readFileSync(file, 'utf8')) as Report)
		const first = reports[0]
		if (first === undefined) throw new Error('no report')
		printReport({ ...first, runs: reports.flatMap((r) => r.runs) })
		return
	}
	const buildDir = process.env.KORA_PARITY_BUILD
	if (buildDir === undefined) throw new Error('run through run.mjs')
	const staticDir = join(buildDir, 'apps')
	const outputJson = OUTPUT_JSON ?? join(buildDir, `parity-${Date.now()}.json`)

	const probeBrowser = await chromium.launch({
		executablePath: process.env.PW_CHROMIUM_PATH || undefined,
	})
	const host = {
		cpus: cpus().length,
		cpuModel: cpus()[0]?.model ?? 'unknown',
		memoryGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
		loadAverageAtStart: loadavg().map((v) => Math.round(v * 100) / 100),
		node: process.version,
		chromium: probeBrowser.version(),
		platform: process.platform,
		runs: RUNS,
		profiles: PROFILES,
		temperatures: TEMPS,
		cpuRates: CPU_RATES,
	}
	await probeBrowser.close()
	log(`host ${JSON.stringify(host)}`)
	const report: Report = {
		host,
		commit: gitCommit(),
		throttle: THROTTLE,
		criticalJsGzip: {
			kora: criticalJsGzip(join(staticDir, 'kora')),
			baseline: criticalJsGzip(join(staticDir, 'baseline')),
		},
		runs: [],
	}
	log(
		`critical-path JS gzip: ${JSON.stringify(report.criticalJsGzip)}; files ${readdirSync(join(staticDir, 'kora', 'assets')).length} Kora assets`,
	)

	const save = (): void => writeFileSync(outputJson, JSON.stringify(report, null, 1))
	for (const size of SIZE_NAMES) {
		const shape = SIZES[size]
		if (shape === undefined) throw new Error(`unknown size ${size}`)
		const regular = TEMPS.filter((t) => t !== 'warm-stale')
		if (regular.length > 0) {
			const runDirectory = mkdtempSync(join(tmpdir(), 'kora-parity-'))
			const server = await startParityServer(shape, runDirectory, staticDir, log)
			const proxy = await startShapingProxy(Number(new URL(server.origin).port))
			const origin = `http://127.0.0.1:${proxy.port}`
			try {
				const targets = await server.targets(3)
				log(`targets ${JSON.stringify(targets)}`)
				for (const cpu of CPU_RATES) {
					for (const profile of PROFILES) {
						for (let run = 0; run < RUNS; run++) {
							const order = run % 2 === 0 ? APPS : [...APPS].reverse()
							const visits: VisitResult[] = []
							const loadAverage = loadavg()[0] ?? 0
							for (const app of order) {
								log(
									`${size} ${cpu}x ${profile} run ${run + 1}/${RUNS}: ${app} (load ${loadAverage.toFixed(2)})`,
								)
								visits.push(
									...(await coldAndWarm(app, cpu, profile, server, origin, targets, proxy, run)),
								)
							}
							report.runs.push({ size, cpu, profile, run, loadAverage, visits })
							save()
						}
					}
				}
			} finally {
				await proxy.close()
				await server.stop()
				rmSync(runDirectory, { recursive: true, force: true })
			}
		}
		if (TEMPS.includes('warm-stale')) {
			for (const cpu of CPU_RATES) {
				for (const profile of PROFILES) {
					for (let run = 0; run < RUNS; run++) {
						const order = run % 2 === 0 ? APPS : [...APPS].reverse()
						const visits: VisitResult[] = []
						const loadAverage = loadavg()[0] ?? 0
						for (const app of order) {
							log(`${size} ${cpu}x ${profile} warm-stale run ${run + 1}/${RUNS}: ${app}`)
							visits.push(await warmStale(app, cpu, profile, shape, staticDir, run))
						}
						report.runs.push({ size, cpu, profile, run, loadAverage, visits })
						save()
					}
				}
			}
		}
	}
	save()
	log(`raw runs: ${outputJson}`)
	printReport(report)
}

await main()

/**
 * First-paint trace of the Kora parity app (first-visit parity, P1 attribution).
 *
 * P1 is what users feel, and the bytes explain only part of it. This records, under the matrix's
 * own link shaping, one cold visit per run in real Chromium with a DevTools trace, and answers
 * three questions for each build (head, and optionally a base checkout):
 *
 *  (a) the request waterfall to first paint: what is on the critical path, what the document
 *      marks render-blocking, which resources carry preload hints, and whether anything that is
 *      not needed for the first paint (the runtime chunk, the WASM, the worker) downloads while
 *      the entry chunk is still arriving;
 *  (b) the main-thread tasks over 50 ms before first paint, with the JavaScript functions that
 *      spent the time (sampled by the V8 profiler inside the trace, mapped to source through the
 *      build's source maps) and a bucket per concern (createApp, KoraProvider mount, query
 *      subscriptions, the write journal, the auth bridge, React, the app);
 *  (c) head against base, by bucket and by function, so a difference is attributed, not guessed.
 *
 * It never runs the benchmark matrix and takes about a minute per run. Run it through
 * `trace.mjs` (README, "First-paint trace"). Nothing here was run when it was written; the trace
 * event names and argument shapes below are Chromium's, and the first run is what confirms them.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Page, chromium } from 'playwright-core'
import type { FixtureShape } from '../browser/fixture-server'
import { startParityServer } from './parity-server'
import { type LinkConditions, startShapingProxy } from './shaping-proxy'

interface Variant {
	name: string
	staticDir: string
}

const NETWORKS: Record<string, LinkConditions> = {
	'slow-4g': {
		rttMs: 150,
		downBytesPerSecond: (1.6 * 1024 * 1024) / 8,
		upBytesPerSecond: (750 * 1024) / 8,
	},
	'4g': { rttMs: 60, downBytesPerSecond: 9_000_000 / 8, upBytesPerSecond: 1_500_000 / 8 },
	broadband: { rttMs: 20, downBytesPerSecond: 50_000_000 / 8, upBytesPerSecond: 10_000_000 / 8 },
}
/** The trace does not need the 20k fixture: first paint does not wait for data. */
const SHAPE: FixtureShape = {
	visibleOps: 2_000,
	tenants: 5,
	insertRate: 0.6,
	batchSize: 100,
	relations: true,
}

const VARIANTS = JSON.parse(process.env.KORA_TRACE_VARIANTS ?? '[]') as Variant[]
const RUNS = Number(process.env.KORA_TRACE_RUNS ?? 3)
const CPU = Number(process.env.KORA_TRACE_CPU ?? 1)
const PROFILE = process.env.KORA_TRACE_PROFILE ?? 'slow-4g'
const OUT = process.env.KORA_TRACE_OUT ?? join(tmpdir(), `kora-trace-${Date.now()}`)
/** How long the trace keeps running after first paint, to see what the paint hands over to. */
const AFTER_PAINT_MS = 3_000
const LONG_TASK_MS = 50

const log = (message: string): void => {
	console.error(`[trace] ${message}`)
}

// ── Trace events ─────────────────────────────────────────────────────────────────────────

interface TraceEvent {
	name: string
	cat?: string
	ph: string
	ts: number
	dur?: number
	pid: number
	tid: number
	id?: string
	args?: Record<string, unknown>
}

const record = (value: unknown): Record<string, unknown> =>
	typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

interface CallFrame {
	functionName: string
	url: string
	lineNumber: number
	columnNumber: number
}

interface ProfileNode {
	id: number
	callFrame: CallFrame
}

interface Samples {
	nodes: Map<number, ProfileNode>
	/** Absolute sample times (trace microseconds) and the node each hit. */
	times: number[]
	hits: number[]
}

/** The V8 sampling profile(s) of one thread, assembled from `Profile` and `ProfileChunk` events. */
function collectSamples(events: TraceEvent[], pid: number, tid: number): Samples {
	const out: Samples = { nodes: new Map(), times: [], hits: [] }
	const starts = new Map<string, number>()
	const clocks = new Map<string, number>()
	for (const e of events) {
		if (e.pid !== pid || e.name !== 'Profile') continue
		const start = record(e.args?.data).startTime
		if (typeof start === 'number' && e.id !== undefined) starts.set(e.id, start)
	}
	const chunks = events
		.filter((e) => e.pid === pid && e.name === 'ProfileChunk')
		.sort((a, b) => a.ts - b.ts)
	for (const e of chunks) {
		if (e.tid !== tid || e.id === undefined) continue
		const data = record(e.args?.data)
		const profile = record(data.cpuProfile)
		for (const raw of (profile.nodes as unknown[] | undefined) ?? []) {
			const node = record(raw)
			const frame = record(node.callFrame)
			out.nodes.set(Number(node.id), {
				id: Number(node.id),
				callFrame: {
					functionName: String(frame.functionName ?? ''),
					url: String(frame.url ?? ''),
					lineNumber: Number(frame.lineNumber ?? -1),
					columnNumber: Number(frame.columnNumber ?? -1),
				},
			})
		}
		const samples = (profile.samples as number[] | undefined) ?? []
		const deltas = (data.timeDeltas as number[] | undefined) ?? []
		let clock = clocks.get(e.id) ?? starts.get(e.id) ?? e.ts
		for (let i = 0; i < samples.length; i++) {
			clock += deltas[i] ?? 0
			out.times.push(clock)
			out.hits.push(samples[i] ?? 0)
		}
		clocks.set(e.id, clock)
	}
	return out
}

// ── Source maps (VLQ decoded in-house: one lookup, no dependency) ────────────────────────

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

interface Segment {
	column: number
	source: number
	name: number
}

interface SourceMap {
	sources: string[]
	names: string[]
	lines: Segment[][]
}

function decodeMap(json: string): SourceMap {
	const raw = JSON.parse(json) as { sources: string[]; names: string[]; mappings: string }
	const lines: Segment[][] = []
	let source = 0
	let name = 0
	for (const lineText of raw.mappings.split(';')) {
		const segments: Segment[] = []
		let column = 0
		for (const part of lineText.split(',')) {
			if (part === '') continue
			const fields: number[] = []
			let shift = 0
			let value = 0
			for (const ch of part) {
				const digit = B64.indexOf(ch)
				value += (digit & 31) << shift
				if (digit & 32) {
					shift += 5
				} else {
					fields.push(value & 1 ? -(value >> 1) : value >> 1)
					shift = 0
					value = 0
				}
			}
			column += fields[0] ?? 0
			if (fields.length >= 4) {
				source += fields[1] ?? 0
				if (fields.length >= 5) name += fields[4] ?? 0
				segments.push({ column, source, name: fields.length >= 5 ? name : -1 })
			}
		}
		lines.push(segments)
	}
	return { sources: raw.sources, names: raw.names, lines }
}

/** The original source and name at a generated position (0-based line and column). */
function originalAt(
	map: SourceMap,
	line: number,
	column: number,
): { source: string; name: string | null } | null {
	const segments = map.lines[line]
	if (segments === undefined || segments.length === 0) return null
	let lo = 0
	let hi = segments.length - 1
	let found = -1
	while (lo <= hi) {
		const mid = (lo + hi) >> 1
		if ((segments[mid]?.column ?? 0) <= column) {
			found = mid
			lo = mid + 1
		} else hi = mid - 1
	}
	const segment = segments[found]
	if (segment === undefined) return null
	return {
		source: map.sources[segment.source] ?? '?',
		name: segment.name >= 0 ? (map.names[segment.name] ?? null) : null,
	}
}

// ── Attribution ──────────────────────────────────────────────────────────────────────────

/** One concern per bucket, tested against `<source> <function name>`; the first match wins. */
const BUCKETS: Array<[string, RegExp]> = [
	['journal', /journal/i],
	['auth bridge', /auth/i],
	['KoraProvider mount', /KoraProvider|react\/dist|packages\/react/i],
	['query subscriptions', /subscribe|deferredQuery|deferred-query|useQuery|query-runner/i],
	['createApp', /createApp|create-app|kora\/dist|korajs\/dist|\/kora\/src\/index/i],
	['core / schema', /packages\/core|@korajs\/core/i],
	['store / sync', /packages\/(store|sync)|@korajs\/(store|sync)/i],
	['react-dom / react', /react-dom|node_modules\/react\/|scheduler/i],
	['app code', /parity\/apps|main\.tsx|screens\.tsx/i],
]

const bucketOf = (text: string): string => BUCKETS.find(([, re]) => re.test(text))?.[0] ?? 'other'

interface FunctionTime {
	key: string
	bucket: string
	selfMs: number
}

interface LongTask {
	startMs: number
	durMs: number
	/** Functions by self time inside the task, largest first. */
	top: FunctionTime[]
}

// ── One run ──────────────────────────────────────────────────────────────────────────────

interface ResourceRow {
	url: string
	file: string
	priority: string
	renderBlocking: string
	startMs: number
	endMs: number | null
	/** Compressed bytes received before first paint. */
	bytesBeforePaint: number
	/** Download is in flight at first paint, or overlaps the critical entry chunk's download. */
	critical: boolean
}

interface RunResult {
	firstPaintMs: number
	navigationToFirstByteMs: number | null
	resources: ResourceRow[]
	longTasks: LongTask[]
	/** Self time before first paint per bucket, ms (all main-thread JavaScript, not only long tasks). */
	buckets: Record<string, number>
	functions: FunctionTime[]
	mainThreadBusyMs: number
	tracePath: string
}

const fileOf = (url: string): string => {
	try {
		return new URL(url).pathname.replace(/^\/[^/]+\//, '')
	} catch {
		return url
	}
}

/** Which of the page's own resources the document itself needs for the first paint. */
function criticalFiles(html: string): Set<string> {
	const files = new Set<string>()
	for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) if (m[1]) files.add(fileOf(m[1]))
	for (const m of html.matchAll(/<link[^>]+rel="(?:modulepreload|stylesheet|preload)"[^>]*>/g)) {
		const href = /href="([^"]+)"/.exec(m[0])?.[1]
		if (href) files.add(fileOf(href))
	}
	return files
}

async function waitForPaint(page: Page): Promise<number | null> {
	const deadline = Date.now() + 120_000
	while (Date.now() < deadline) {
		const painted = await page.evaluate(() => window.__parity?.shellPaint ?? null)
		if (painted !== null) return painted
		await new Promise((r) => setTimeout(r, 100))
	}
	return null
}

async function oneRun(
	variant: Variant,
	runIndex: number,
	origin: string,
	initScript: string,
	html: string,
): Promise<RunResult | null> {
	const maps = new Map<string, SourceMap | null>()
	const mapFor = (url: string): SourceMap | null => {
		if (maps.has(url)) return maps.get(url) ?? null
		let map: SourceMap | null = null
		try {
			const path = join(variant.staticDir, new URL(url).pathname.replace(/^\//, ''))
			if (existsSync(`${path}.map`)) map = decodeMap(readFileSync(`${path}.map`, 'utf8'))
		} catch {
			map = null
		}
		maps.set(url, map)
		return map
	}

	const browser = await chromium.launch({
		executablePath: process.env.PW_CHROMIUM_PATH || undefined,
	})
	try {
		const context = await browser.newContext()
		await context.addInitScript({ content: initScript })
		const page = await context.newPage()
		const cdp = await context.newCDPSession(page)
		if (CPU !== 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU })

		// Network facts from the protocol; the same monotonic clock as the trace (seconds vs µs).
		await cdp.send('Network.enable')
		const sent = new Map<string, { url: string; at: number; priority: string }>()
		const finished = new Map<string, number>()
		const received: Array<{ id: string; at: number; bytes: number }> = []
		cdp.on('Network.requestWillBeSent', (e) => {
			sent.set(e.requestId, {
				url: e.request.url,
				at: e.timestamp * 1e6,
				priority: String(e.request.initialPriority ?? ''),
			})
		})
		cdp.on('Network.dataReceived', (e) => {
			received.push({ id: e.requestId, at: e.timestamp * 1e6, bytes: e.encodedDataLength })
		})
		cdp.on('Network.loadingFinished', (e) => finished.set(e.requestId, e.timestamp * 1e6))

		await browser.startTracing(page, {
			categories: [
				'-*',
				'devtools.timeline',
				'disabled-by-default-devtools.timeline',
				'disabled-by-default-v8.cpu_profiler',
				'v8.execute',
				'blink.user_timing',
				'loading',
				'navigation',
			],
		})
		await page.goto(`${origin}/kora/`, { waitUntil: 'commit' })
		const paintPageMs = await waitForPaint(page)
		if (paintPageMs === null) {
			await browser.stopTracing()
			log(`${variant.name} run ${runIndex}: no first paint`)
			return null
		}
		await new Promise((r) => setTimeout(r, AFTER_PAINT_MS))
		const traceBuffer = await browser.stopTracing()
		const tracePath = join(OUT, `${variant.name}-run${runIndex}.trace.json`)
		writeFileSync(tracePath, traceBuffer)
		const parsed = JSON.parse(traceBuffer.toString('utf8')) as { traceEvents: TraceEvent[] }
		const events = parsed.traceEvents

		// The renderer main thread of the page: the thread that emitted this document's navigationStart.
		const nav = events.find(
			(e) =>
				e.name === 'navigationStart' &&
				String(record(e.args?.data).documentLoaderURL ?? '').includes('/kora/'),
		)
		if (nav === undefined) throw new Error('no navigationStart for the app in the trace')
		const originUs = nav.ts
		const paintUs = originUs + paintPageMs * 1000

		// (a) resources
		const requests = events.filter((e) => e.name === 'ResourceSendRequest' && e.pid === nav.pid)
		const blocking = new Map<string, string>()
		for (const e of requests) {
			const data = record(e.args?.data)
			if (typeof data.requestId === 'string')
				blocking.set(data.requestId, String(data.renderBlocking ?? ''))
		}
		const needed = criticalFiles(html)
		const entryDownloads = [...sent.entries()]
			.filter(([, r]) => needed.has(fileOf(r.url)) && /\.js$/.test(r.url))
			.map(([id, r]) => ({ start: r.at, end: finished.get(id) ?? r.at }))
		const entryStart = Math.min(...entryDownloads.map((d) => d.start))
		const entryEnd = Math.max(...entryDownloads.map((d) => d.end))
		const resources: ResourceRow[] = []
		for (const [id, r] of sent) {
			if (!r.url.startsWith(origin)) continue
			const end = finished.get(id) ?? null
			const before = received
				.filter((d) => d.id === id && d.at <= paintUs)
				.reduce((sum, d) => sum + d.bytes, 0)
			const overlapsEntry = r.at < entryEnd && (end ?? Number.POSITIVE_INFINITY) > entryStart
			resources.push({
				url: r.url,
				file: fileOf(r.url) || '(document)',
				priority: r.priority,
				renderBlocking: blocking.get(id) ?? '',
				startMs: (r.at - originUs) / 1000,
				endMs: end === null ? null : (end - originUs) / 1000,
				bytesBeforePaint: before,
				critical: needed.has(fileOf(r.url)) || (r.at < paintUs && overlapsEntry),
			})
		}
		resources.sort((a, b) => a.startMs - b.startMs)

		// (b) long tasks before first paint, with sampled functions
		const mainTid = nav.tid
		const samples = collectSamples(events, nav.pid, mainTid)
		const tasks = events
			.filter((e) => e.name === 'RunTask' && e.pid === nav.pid && e.tid === mainTid && e.ph === 'X')
			.filter((e) => e.ts >= originUs && e.ts <= paintUs)
		const attribute = (fromUs: number, toUs: number): FunctionTime[] => {
			const byKey = new Map<string, FunctionTime>()
			for (let i = 0; i < samples.times.length; i++) {
				const t = samples.times[i] ?? 0
				if (t < fromUs || t > toUs) continue
				const node = samples.nodes.get(samples.hits[i] ?? -1)
				if (node === undefined) continue
				const next = samples.times[i + 1] ?? t
				const weightMs = Math.max(0, Math.min(next - t, 5_000)) / 1000
				const frame = node.callFrame
				const origin = frame.url === '' ? null : mapFor(frame.url)
				const mapped = origin ? originalAt(origin, frame.lineNumber, frame.columnNumber) : null
				const where = mapped
					? mapped.source.replace(/^(\.\.\/)+/, '')
					: fileOf(frame.url) || '(native)'
				const fn = mapped?.name ?? (frame.functionName || '(anonymous)')
				const key = `${fn}  ${where}`
				const row = byKey.get(key) ?? { key, bucket: bucketOf(`${where} ${fn}`), selfMs: 0 }
				row.selfMs += weightMs
				byKey.set(key, row)
			}
			return [...byKey.values()].sort((a, b) => b.selfMs - a.selfMs)
		}
		const longTasks: LongTask[] = tasks
			.filter((e) => (e.dur ?? 0) / 1000 >= LONG_TASK_MS)
			.map((e) => ({
				startMs: (e.ts - originUs) / 1000,
				durMs: (e.dur ?? 0) / 1000,
				top: attribute(e.ts, e.ts + (e.dur ?? 0)).slice(0, 8),
			}))
		const all = attribute(originUs, paintUs)
		const buckets: Record<string, number> = {}
		for (const f of all) buckets[f.bucket] = (buckets[f.bucket] ?? 0) + f.selfMs

		const firstByte = requests.length > 0 ? ((requests[0]?.ts ?? originUs) - originUs) / 1000 : null
		return {
			firstPaintMs: paintPageMs,
			navigationToFirstByteMs: firstByte,
			resources,
			longTasks,
			buckets,
			functions: all.slice(0, 40),
			mainThreadBusyMs: tasks.reduce((sum, e) => sum + (e.dur ?? 0), 0) / 1000,
			tracePath,
		}
	} finally {
		await browser.close()
	}
}

// ── Reporting ────────────────────────────────────────────────────────────────────────────

const median = (values: number[]): number => {
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN
}
const f1 = (n: number): string => (Number.isFinite(n) ? n.toFixed(1) : 'n/a')

interface VariantResult {
	name: string
	runs: RunResult[]
}

function waterfall(result: VariantResult): string {
	const run =
		result.runs.find((r) => r.firstPaintMs === median(result.runs.map((x) => x.firstPaintMs))) ??
		result.runs[0]
	if (run === undefined) return `### ${result.name}: no successful run\n`
	const rows = run.resources.map(
		(r) =>
			`| ${r.file} | ${r.priority} | ${r.renderBlocking || '-'} | ${f1(r.startMs)} | ${r.endMs === null ? 'open' : f1(r.endMs)} | ${(r.bytesBeforePaint / 1024).toFixed(1)} | ${r.critical ? 'yes' : '**no**'} |`,
	)
	const competing = run.resources.filter(
		(r) => !r.critical && r.startMs < run.firstPaintMs && r.bytesBeforePaint > 0,
	)
	const bytes = competing.reduce((sum, r) => sum + r.bytesBeforePaint, 0)
	return [
		`### ${result.name}: request waterfall (the run at the median first paint, ${f1(run.firstPaintMs)} ms)`,
		'',
		'| Resource | Priority | Render-blocking | Start ms | End ms | KiB before paint | On the critical path |',
		'|---|---|---|---|---|---|---|',
		...rows,
		'',
		competing.length === 0
			? 'Nothing outside the critical path received bytes before first paint.'
			: `**Competing for bandwidth before first paint: ${competing.map((r) => r.file).join(', ')} (${(bytes / 1024).toFixed(1)} KiB, about ${((bytes / 209_715) * 1000).toFixed(0)} ms of Slow 4G).** Delay these until after first paint (requestIdleCallback or an after-paint hook).`,
		'',
	].join('\n')
}

function report(results: VariantResult[]): string {
	const out: string[] = [`# First-paint trace, ${PROFILE}, CPU ${CPU}x, ${RUNS} runs per build`, '']
	out.push(
		'| Build | First paint p50 (ms) | Main-thread busy before paint (ms) | Long tasks (count / total ms) |',
	)
	out.push('|---|---|---|---|')
	for (const r of results) {
		const long = r.runs.map((x) => x.longTasks)
		out.push(
			`| ${r.name} | ${f1(median(r.runs.map((x) => x.firstPaintMs)))} | ${f1(median(r.runs.map((x) => x.mainThreadBusyMs)))} | ${f1(median(long.map((l) => l.length)))} / ${f1(median(long.map((l) => l.reduce((s, t) => s + t.durMs, 0))))} |`,
		)
	}
	out.push('', '## (a) Request waterfall', '')
	for (const r of results) out.push(waterfall(r))
	out.push(
		'## (b) Main-thread JavaScript before first paint, by concern (self time, median ms)',
		'',
	)
	const names = [...new Set(results.flatMap((r) => r.runs.flatMap((x) => Object.keys(x.buckets))))]
	out.push(
		`| Concern | ${results.map((r) => r.name).join(' | ')}${results.length === 2 ? ' | delta' : ''} |`,
	)
	out.push(`|---|${results.map(() => '---|').join('')}${results.length === 2 ? '---|' : ''}`)
	const perBucket = (r: VariantResult, b: string): number =>
		median(r.runs.map((x) => x.buckets[b] ?? 0))
	for (const b of names.sort()) {
		const values = results.map((r) => perBucket(r, b))
		const delta = results.length === 2 ? ` | ${f1((values[0] ?? 0) - (values[1] ?? 0))}` : ''
		out.push(`| ${b} | ${values.map(f1).join(' | ')}${delta} |`)
	}
	out.push('', '## (b) Long tasks before first paint (median run of each build)', '')
	for (const r of results) {
		const run = r.runs[Math.floor(r.runs.length / 2)]
		out.push(`### ${r.name}`, '')
		for (const task of run?.longTasks ?? []) {
			out.push(`- at ${f1(task.startMs)} ms, ${f1(task.durMs)} ms long:`)
			for (const f of task.top.slice(0, 5))
				out.push(`  - ${f1(f.selfMs)} ms [${f.bucket}] ${f.key}`)
		}
		if ((run?.longTasks.length ?? 0) === 0) out.push('No task over 50 ms before first paint.')
		out.push('')
	}
	if (results.length === 2) {
		out.push(
			'## (c) Delta by function, head minus base (median ms of self time before first paint)',
			'',
		)
		const [head, base] = results as [VariantResult, VariantResult]
		const table = (r: VariantResult): Map<string, number> => {
			const keys = new Set(r.runs.flatMap((x) => x.functions.map((f) => f.key)))
			const m = new Map<string, number>()
			for (const k of keys) {
				m.set(k, median(r.runs.map((x) => x.functions.find((f) => f.key === k)?.selfMs ?? 0)))
			}
			return m
		}
		const h = table(head)
		const b = table(base)
		const keys = [...new Set([...h.keys(), ...b.keys()])]
		const rows = keys
			.map((k) => ({ k, head: h.get(k) ?? 0, base: b.get(k) ?? 0 }))
			.sort((x, y) => Math.abs(y.head - y.base) - Math.abs(x.head - x.base))
			.slice(0, 25)
		out.push('| Function (source) | head | base | delta |', '|---|---|---|---|')
		for (const row of rows)
			out.push(`| ${row.k} | ${f1(row.head)} | ${f1(row.base)} | ${f1(row.head - row.base)} |`)
		out.push('')
	}
	return out.join('\n')
}

// ── Main ─────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	if (VARIANTS.length === 0) throw new Error('run through trace.mjs')
	const link = NETWORKS[PROFILE]
	if (link === undefined) throw new Error(`unknown profile ${PROFILE}`)
	mkdirSync(OUT, { recursive: true })
	const results: VariantResult[] = []
	const runDirectory = mkdtempSync(join(tmpdir(), 'kora-trace-'))
	try {
		// Alternate the builds run by run, so drift in the machine hits both.
		const perVariant = new Map<string, RunResult[]>(VARIANTS.map((v) => [v.name, []]))
		for (let i = 0; i < RUNS; i++) {
			for (const variant of i % 2 === 0 ? VARIANTS : [...VARIANTS].reverse()) {
				const server = await startParityServer(SHAPE, runDirectory, variant.staticDir, log)
				const proxy = await startShapingProxy(Number(new URL(server.origin).port))
				try {
					proxy.setConditions(link)
					const origin = `http://127.0.0.1:${proxy.port}`
					const token = `trace-${variant.name}-${i}-${Date.now()}`
					const init = `try { localStorage.setItem('parity-token', ${JSON.stringify(token)}) } catch {}\nwindow.__parityConfig = ${JSON.stringify({ school: server.meta.school, expectHome: await server.homeRows() })}`
					const html = readFileSync(join(variant.staticDir, 'kora/index.html'), 'utf8')
					log(`${variant.name} run ${i + 1}/${RUNS}`)
					const run = await oneRun(variant, i, origin, init, html)
					if (run !== null) perVariant.get(variant.name)?.push(run)
				} finally {
					await proxy.close()
					await server.stop()
				}
			}
		}
		for (const v of VARIANTS) results.push({ name: v.name, runs: perVariant.get(v.name) ?? [] })
	} finally {
		rmSync(runDirectory, { recursive: true, force: true })
	}
	writeFileSync(join(OUT, 'trace-results.json'), JSON.stringify(results, null, 2))
	const text = report(results)
	writeFileSync(join(OUT, 'report.md'), text)
	console.log(text)
	log(`raw traces (open them in the DevTools Performance panel) and report.md are in ${OUT}`)
}

await main()

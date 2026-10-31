import { execFileSync } from 'node:child_process'
/**
 * Browser first-sync harness, orchestrator (C1.0(b), docs/design/fast-first-sync.md).
 *
 * For each fixture size and network profile it starts a real Kora sync server loaded with the
 * LMS-like fixture, then repeats N times: a fresh Chromium context (cold profile: empty OPFS,
 * empty HTTP cache), the built page boots `createApp` on the real SQLite WASM worker with OPFS,
 * the network is throttled over CDP, and the page times a first sync. Results are summarized
 * as median and p95 and written as a Markdown table plus raw JSON.
 *
 * Run through `run.mjs` (it bundles this file); see README.md.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { cpus, loadavg, tmpdir, totalmem } from 'node:os'
import { extname, join } from 'node:path'
import { type Page, chromium } from 'playwright-core'
import { throttleNetwork } from '../../src/playwright/network'
import { startByteCounter } from './byte-counter'
import { type FixtureMeta, type FixtureShape, startFixtureServer } from './fixture-server'
import type { BootConfig, BootResult, SyncMetrics } from './page/page-entry'
import { type Summary, summarize } from './stats'

/** Named fixture shapes. `20k-1` and `20k-5` are the two sizes the Node benchmark reports. */
const SIZES: Record<string, FixtureShape> = {
	// 2,000 visible operations of 10,000 in the log (5 schools): a small school.
	small: { visibleOps: 2_000, tenants: 5, insertRate: 0.6, batchSize: 100 },
	// Threshold study for staged replication (S3): 500, 1,000 and 5,000 operations, 1 school.
	'500-1': { visibleOps: 500, tenants: 1, insertRate: 0.6, batchSize: 100 },
	'1k-1': { visibleOps: 1_000, tenants: 1, insertRate: 0.6, batchSize: 100 },
	'5k-1': { visibleOps: 5_000, tenants: 1, insertRate: 0.6, batchSize: 100 },
	// 20,000 operations, 1 school (the Node benchmark's "best C2 can do" run).
	'20k-1': { visibleOps: 20_000, tenants: 1, insertRate: 0.6, batchSize: 100 },
	// 20,000 visible of 100,000 in the log (the Node benchmark's default).
	'20k-5': { visibleOps: 20_000, tenants: 5, insertRate: 0.6, batchSize: 100 },
	// Same 20,000 operations, but records are updated many times: about 4 operations per record.
	'20k-1-high-ratio': { visibleOps: 20_000, tenants: 1, insertRate: 0.2, batchSize: 100 },
	// 100,000 operations, 1 school: the memory ceiling study of the staging replica (S3).
	'100k-1': { visibleOps: 100_000, tenants: 1, insertRate: 0.6, batchSize: 100 },
	// 60,000 operations, 1 school: three times the Node benchmark's visible size.
	'60k-1': { visibleOps: 60_000, tenants: 1, insertRate: 0.6, batchSize: 100 },
}

type ProfileName = 'slow-4g' | 'unthrottled'

const SIZE_NAMES = (process.env.KORA_BROWSER_BENCH_SIZES ?? 'small,20k-1,20k-5').split(',')
const PROFILES = (process.env.KORA_BROWSER_BENCH_PROFILES ?? 'slow-4g,unthrottled').split(
	',',
) as ProfileName[]
/** `full-scope` (default) runs the whole initial sync; `first-home-row` stops at the first row. */
const UNTIL = (process.env.KORA_BROWSER_BENCH_UNTIL ?? 'full-scope') as
	| 'full-scope'
	| 'first-home-row'
/** `reactive` (createApp's default) or `disabled`: see BootConfig.querySubsets. */
const SUBSETS = (process.env.KORA_BROWSER_BENCH_SUBSETS ?? 'reactive') as 'reactive' | 'disabled'
/** `default` (the engine's), `off` (`bulkReplication: false`) or `on` (`minOperations: 0`). */
const BULK = (process.env.KORA_BROWSER_BENCH_BULK ?? 'default') as 'default' | 'off' | 'on'
const RUNS = Number(process.env.KORA_BROWSER_BENCH_RUNS ?? 5)
const OUTPUT_JSON = process.env.KORA_BROWSER_BENCH_JSON

interface RunRecord {
	boot: BootResult
	sync: SyncMetrics
	wireDownBytes: number
	wireUpBytes: number
	/** Null when the run stopped at the first home row. */
	opsPerSecond: number | null
	/** Resident memory of every browser process (page, workers, GPU), MiB: at idle after boot, and the peak during the sync. */
	rssIdleMiB: number | null
	rssPeakMiB: number | null
}

interface ConfigResult {
	size: string
	shape: FixtureShape
	meta: Omit<FixtureMeta, 'digests'>
	profile: ProfileName
	until: typeof UNTIL
	querySubsets: typeof SUBSETS
	runs: RunRecord[]
}

const log = (message: string): void => {
	console.error(`[browser-bench] ${message}`)
}

const buildDirFromLauncher = process.env.KORA_BROWSER_BENCH_BUILD
if (!buildDirFromLauncher) throw new Error('run through run.mjs')
const buildDir: string = buildDirFromLauncher

const MIME: Record<string, string> = {
	'.js': 'text/javascript',
	'.html': 'text/html',
	'.wasm': 'application/wasm',
}

/** Static server for the built page, with the isolation headers SQLite WASM + OPFS need. */
async function serveBuild(): Promise<{ origin: string; close(): Promise<void> }> {
	const server = createServer((request, response) => {
		const pathname = new URL(request.url ?? '/', 'http://x').pathname
		const file = join(buildDir, pathname === '/' ? 'index.html' : pathname.replace(/\.\./g, ''))
		try {
			const body = readFileSync(file)
			response.writeHead(200, {
				'content-type': MIME[extname(file)] ?? 'application/octet-stream',
				'cross-origin-opener-policy': 'same-origin',
				'cross-origin-embedder-policy': 'require-corp',
				'cache-control': 'no-store',
			})
			response.end(body)
		} catch {
			response.writeHead(404)
			response.end()
		}
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address = server.address()
	if (address === null || typeof address !== 'object') throw new Error('static server did not bind')
	return {
		origin: `http://127.0.0.1:${address.port}`,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	}
}

/** The browser's main process: the child of this process started with a remote-debugging pipe. */
function findBrowserPid(): number | null {
	try {
		const table = execFileSync('ps', ['-e', '-o', 'pid=,ppid=,args='], { encoding: 'utf8' })
		for (const line of table.split('\n')) {
			const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
			if (!match) continue
			if (Number(match[2]) === process.pid && /--remote-debugging/.test(match[3] ?? '')) {
				return Number(match[1])
			}
		}
	} catch {
		// No ps: memory is not reported.
	}
	return null
}

/** Resident memory (MiB) of `rootPid` and every process below it: the page, workers, GPU and utility processes. */
function processTreeRssMiB(rootPid: number): number | null {
	try {
		const table = execFileSync('ps', ['-e', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' })
		const children = new Map<number, number[]>()
		const rss = new Map<number, number>()
		for (const line of table.split('\n')) {
			const [pid, ppid, kib] = line.trim().split(/\s+/).map(Number)
			if (pid === undefined || ppid === undefined || kib === undefined || Number.isNaN(pid))
				continue
			rss.set(pid, kib)
			children.set(ppid, [...(children.get(ppid) ?? []), pid])
		}
		let total = 0
		const stack = [rootPid]
		while (stack.length > 0) {
			const pid = stack.pop()
			if (pid === undefined) break
			total += rss.get(pid) ?? 0
			stack.push(...(children.get(pid) ?? []))
		}
		return total / 1024
	} catch {
		return null
	}
}

async function runOnce(
	page: Page,
	origin: string,
	syncPort: number,
	meta: FixtureMeta,
	profile: ProfileName,
	index: number,
	rootPid: number | null,
): Promise<{
	boot: BootResult
	sync: SyncMetrics
	rssIdleMiB: number | null
	rssPeakMiB: number | null
}> {
	await page.goto(`${origin}/`)
	const config: BootConfig = {
		syncUrl: `ws://127.0.0.1:${syncPort}`,
		token: `bench-user-${index}-${Date.now()}`,
		db: `first-sync-${index}`,
		querySubsets: SUBSETS,
		bulk: BULK,
		debugEvents: process.env.KORA_BROWSER_BENCH_DEBUG === '1',
	}
	const boot = await page.evaluate((c) => window.__bench.boot(c), config)
	// Let boot-time background work (persistence request, worker warm-up) finish so the
	// timed region starts from an idle page.
	await new Promise((resolve) => setTimeout(resolve, 1_000))
	const throttle = profile === 'slow-4g' ? await throttleNetwork(page, 'slow-4g') : null
	const rssIdleMiB = rootPid === null ? null : processTreeRssMiB(rootPid)
	let rssPeakMiB = rssIdleMiB
	const sampler =
		rootPid === null
			? null
			: setInterval(() => {
					const now = processTreeRssMiB(rootPid)
					if (now !== null && (rssPeakMiB === null || now > rssPeakMiB)) rssPeakMiB = now
				}, 250)
	try {
		const expectation = {
			until: UNTIL,
			school: meta.school,
			homeCollection: meta.homeCollection,
			collections: meta.collections,
			homeRows: meta.homeRows,
			digests: meta.digests,
		}
		const sync = await page.evaluate((e) => window.__bench.sync(e), expectation)
		const rssAtEnd = rootPid === null ? null : processTreeRssMiB(rootPid)
		if (rssAtEnd !== null && (rssPeakMiB === null || rssAtEnd > rssPeakMiB)) rssPeakMiB = rssAtEnd
		return { boot, sync, rssIdleMiB, rssPeakMiB }
	} finally {
		if (sampler !== null) clearInterval(sampler)
		await throttle?.reset()
	}
}

const fmtMs = (ms: number): string => (Number.isFinite(ms) ? ms.toFixed(0) : 'n/a')
const fmtS = (ms: number): string => (Number.isFinite(ms) ? (ms / 1000).toFixed(2) : 'n/a')
const cell = (s: Summary, fmt: (v: number) => string): string => `${fmt(s.median)} / ${fmt(s.p95)}`

function markdown(results: ConfigResult[]): string {
	const lines: string[] = []
	lines.push(
		'| size (visible ops / log, ops per record) | network | query subsets | handshake s | first home row s | full scope s | ops/s | main-thread stalls ms (count, max) | peak JS heap MiB | down wire / JSON KiB |',
	)
	lines.push('|---|---|---|---|---|---|---|---|---|---|')
	for (const r of results) {
		const col = (pick: (run: RunRecord) => number | null): Summary =>
			summarize(r.runs.map(pick).filter((v): v is number => v !== null))
		const handshake = col((x) => x.sync.handshakeMs)
		const home = col((x) => x.sync.firstHomeRowMs)
		const full = col((x) => x.sync.fullScopeMs)
		const ops = col((x) => x.opsPerSecond)
		const longTotal = col((x) => x.sync.stallTotalMs)
		const longCount = col((x) => x.sync.stallCount)
		const longMax = col((x) => x.sync.stallMaxMs)
		const heap = col((x) => x.sync.peakHeapMiB)
		const wire = col((x) => x.wireDownBytes / 1024)
		const json = col((x) => x.sync.downJsonBytes / 1024)
		lines.push(
			`| ${r.size}: ${r.meta.visibleOps.toLocaleString('en-US')} / ${r.meta.totalOps.toLocaleString('en-US')}, ${r.meta.opsPerRecord.toFixed(1)} | ${r.profile} | ${r.querySubsets} | ${cell(handshake, fmtS)} | ${cell(home, fmtS)} | ${cell(full, fmtS)} | ${cell(ops, fmtMs)} | ${cell(longTotal, fmtMs)} (${longCount.median.toFixed(0)}, max ${longMax.max.toFixed(0)}) | ${cell(heap, fmtMs)} | ${cell(wire, fmtMs)} / ${fmtMs(json.median)} |`,
		)
	}
	return lines.join('\n')
}

async function main(): Promise<void> {
	const runDirectory = mkdtempSync(join(tmpdir(), 'kora-browser-first-sync-'))
	mkdirSync(buildDir, { recursive: true })
	const results: ConfigResult[] = []
	const web = await serveBuild()
	const browser = await chromium.launch({
		executablePath: process.env.PW_CHROMIUM_PATH || undefined,
		args: [
			'--disable-background-timer-throttling',
			'--disable-renderer-backgrounding',
			// Exact usedJSHeapSize instead of the bucketed default.
			'--enable-precise-memory-info',
		],
	})
	const host = {
		cpus: cpus().length,
		cpuModel: cpus()[0]?.model ?? 'unknown',
		memoryGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
		loadAverageAtStart: loadavg().map((v) => Math.round(v * 100) / 100),
		node: process.version,
		chromium: browser.version(),
		platform: process.platform,
	}
	log(`host ${JSON.stringify(host)}`)
	let failed = false
	try {
		for (const size of SIZE_NAMES) {
			const shape = SIZES[size]
			if (shape === undefined) throw new Error(`unknown size ${size}`)
			const fixture = await startFixtureServer(shape, runDirectory, log)
			const counter = await startByteCounter(fixture.port)
			try {
				for (const profile of PROFILES) {
					const runs: RunRecord[] = []
					for (let i = 0; i < RUNS; i++) {
						const context = await browser.newContext()
						const page = await context.newPage()
						page.on('pageerror', (error) => log(`page error: ${error.message}`))
						page.on('console', (message) => {
							if (message.type() === 'error' || process.env.KORA_BROWSER_BENCH_DEBUG)
								log(`console ${message.type()}: ${message.text()}`)
						})
						counter.reset()
						try {
							const { boot, sync, rssIdleMiB, rssPeakMiB } = await runOnce(
								page,
								web.origin,
								counter.port,
								fixture.meta,
								profile,
								i,
								findBrowserPid(),
							)
							const wire = counter.read()
							const record: RunRecord = {
								boot,
								sync,
								wireDownBytes: wire.downBytes,
								wireUpBytes: wire.upBytes,
								opsPerSecond:
									sync.fullScopeMs === null
										? null
										: sync.operationsReceived / (sync.fullScopeMs / 1000),
								rssIdleMiB,
								rssPeakMiB,
							}
							if (sync.mismatches.length > 0) {
								failed = true
								log(`MISMATCH ${size} ${profile} run ${i}: ${sync.mismatches.join(', ')}`)
							}
							runs.push(record)
							log(
								`${size} ${profile} run ${i + 1}/${RUNS} [${boot.storage.persistence}, durable=${boot.storage.durable}, boot ${fmtMs(boot.bootMs)} ms]: handshake ${fmtMs(sync.handshakeMs ?? Number.NaN)} ms, home row ${fmtMs(sync.firstHomeRowMs ?? Number.NaN)} ms, full ${fmtMs(sync.fullScopeMs ?? Number.NaN)} ms, ${sync.operationsReceived} ops, long tasks ${fmtMs(sync.longTaskTotalMs)} ms, stalls ${sync.stallCount} (${fmtMs(sync.stallTotalMs)} ms, max ${fmtMs(sync.stallMaxMs)}), staging ${JSON.stringify(sync.staging)}, browser RSS idle ${rssIdleMiB?.toFixed(0) ?? 'n/a'} MiB, peak ${rssPeakMiB?.toFixed(0) ?? 'n/a'} MiB, worker requests ${JSON.stringify(sync.workerRequests)}, messages ${JSON.stringify(sync.messageTypes)}`,
							)
						} finally {
							await context.close()
						}
						await new Promise((resolve) => setTimeout(resolve, 1_000))
					}
					if (
						BULK === 'on' &&
						!runs.some((run) => run.sync.staging.includes('sync:staging-merged'))
					) {
						// The browser (OPFS plus a second in-memory worker) path is only tested if it ran.
						failed = true
						log(
							`NO STAGED MERGE ${size} ${profile}: no run merged a staging replica (${JSON.stringify(runs.map((run) => run.sync.staging))})`,
						)
					}
					const { digests: _digests, ...meta } = fixture.meta
					results.push({ size, shape, meta, profile, until: UNTIL, querySubsets: SUBSETS, runs })
				}
			} finally {
				await counter.close()
				await fixture.stop()
			}
		}
	} finally {
		await browser.close()
		await web.close()
		rmSync(runDirectory, { recursive: true, force: true })
	}
	console.log(`\nHost: ${JSON.stringify(host)}\nRuns per configuration: ${RUNS}\n`)
	console.log('Median / p95 (nearest rank; the maximum at 5 runs)\n')
	console.log(markdown(results))
	if (OUTPUT_JSON) writeFileSync(OUTPUT_JSON, JSON.stringify({ host, results }, null, 2))
	if (failed) {
		console.error('\nFAIL: a device did not match the server (see MISMATCH lines above)')
		process.exitCode = 1
	}
}

await main()

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
	// 20,000 operations, 1 school (the Node benchmark's "best C2 can do" run).
	'20k-1': { visibleOps: 20_000, tenants: 1, insertRate: 0.6, batchSize: 100 },
	// 20,000 visible of 100,000 in the log (the Node benchmark's default).
	'20k-5': { visibleOps: 20_000, tenants: 5, insertRate: 0.6, batchSize: 100 },
	// Same 20,000 operations, but records are updated many times: about 4 operations per record.
	'20k-1-high-ratio': { visibleOps: 20_000, tenants: 1, insertRate: 0.2, batchSize: 100 },
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
const RUNS = Number(process.env.KORA_BROWSER_BENCH_RUNS ?? 5)
const OUTPUT_JSON = process.env.KORA_BROWSER_BENCH_JSON

interface RunRecord {
	boot: BootResult
	sync: SyncMetrics
	wireDownBytes: number
	wireUpBytes: number
	/** Null when the run stopped at the first home row. */
	opsPerSecond: number | null
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

async function runOnce(
	page: Page,
	origin: string,
	syncPort: number,
	meta: FixtureMeta,
	profile: ProfileName,
	index: number,
): Promise<{ boot: BootResult; sync: SyncMetrics }> {
	await page.goto(`${origin}/`)
	const config: BootConfig = {
		syncUrl: `ws://127.0.0.1:${syncPort}`,
		token: `bench-user-${index}-${Date.now()}`,
		db: `first-sync-${index}`,
		querySubsets: SUBSETS,
		debugEvents: process.env.KORA_BROWSER_BENCH_DEBUG === '1',
	}
	const boot = await page.evaluate((c) => window.__bench.boot(c), config)
	// Let boot-time background work (persistence request, worker warm-up) finish so the
	// timed region starts from an idle page.
	await new Promise((resolve) => setTimeout(resolve, 1_000))
	const throttle = profile === 'slow-4g' ? await throttleNetwork(page, 'slow-4g') : null
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
		return { boot, sync }
	} finally {
		await throttle?.reset()
	}
}

const fmtMs = (ms: number): string => (Number.isFinite(ms) ? ms.toFixed(0) : 'n/a')
const fmtS = (ms: number): string => (Number.isFinite(ms) ? (ms / 1000).toFixed(2) : 'n/a')
const cell = (s: Summary, fmt: (v: number) => string): string => `${fmt(s.median)} / ${fmt(s.p95)}`

function markdown(results: ConfigResult[]): string {
	const lines: string[] = []
	lines.push(
		'| size (visible ops / log, ops per record) | network | query subsets | handshake s | first home row s | full scope s | ops/s | long tasks ms (count) | peak JS heap MiB | down wire / JSON KiB |',
	)
	lines.push('|---|---|---|---|---|---|---|---|---|---|')
	for (const r of results) {
		const col = (pick: (run: RunRecord) => number | null): Summary =>
			summarize(r.runs.map(pick).filter((v): v is number => v !== null))
		const handshake = col((x) => x.sync.handshakeMs)
		const home = col((x) => x.sync.firstHomeRowMs)
		const full = col((x) => x.sync.fullScopeMs)
		const ops = col((x) => x.opsPerSecond)
		const longTotal = col((x) => x.sync.longTaskTotalMs)
		const longCount = col((x) => x.sync.longTaskCount)
		const heap = col((x) => x.sync.peakHeapMiB)
		const wire = col((x) => x.wireDownBytes / 1024)
		const json = col((x) => x.sync.downJsonBytes / 1024)
		lines.push(
			`| ${r.size}: ${r.meta.visibleOps.toLocaleString('en-US')} / ${r.meta.totalOps.toLocaleString('en-US')}, ${r.meta.opsPerRecord.toFixed(1)} | ${r.profile} | ${r.querySubsets} | ${cell(handshake, fmtS)} | ${cell(home, fmtS)} | ${cell(full, fmtS)} | ${cell(ops, fmtMs)} | ${cell(longTotal, fmtMs)} (${longCount.median.toFixed(0)}) | ${cell(heap, fmtMs)} | ${cell(wire, fmtMs)} / ${fmtMs(json.median)} |`,
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
							const { boot, sync } = await runOnce(
								page,
								web.origin,
								counter.port,
								fixture.meta,
								profile,
								i,
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
							}
							if (sync.mismatches.length > 0) {
								failed = true
								log(`MISMATCH ${size} ${profile} run ${i}: ${sync.mismatches.join(', ')}`)
							}
							runs.push(record)
							log(
								`${size} ${profile} run ${i + 1}/${RUNS} [${boot.storage.persistence}, durable=${boot.storage.durable}, boot ${fmtMs(boot.bootMs)} ms]: handshake ${fmtMs(sync.handshakeMs ?? Number.NaN)} ms, home row ${fmtMs(sync.firstHomeRowMs ?? Number.NaN)} ms, full ${fmtMs(sync.fullScopeMs ?? Number.NaN)} ms, ${sync.operationsReceived} ops, long tasks ${fmtMs(sync.longTaskTotalMs)} ms, worker requests ${JSON.stringify(sync.workerRequests)}, messages ${JSON.stringify(sync.messageTypes)}`,
							)
						} finally {
							await context.close()
						}
						await new Promise((resolve) => setTimeout(resolve, 1_000))
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

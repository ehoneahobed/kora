/**
 * STORE-16: store benchmark gates in a REAL browser.
 *
 * The node gates run better-sqlite3 in-process; this one runs the built
 * @korajs/store in Chromium on Kora's dedicated SQLite worker, SQLite WASM and OPFS
 * (opfs-sahpool), plus the IndexedDB fallback with its real snapshot persistence,
 * and gates the results against the CLAUDE.md targets (10% regression buffer).
 *
 * Run (from the repo root, after `pnpm --filter @korajs/core --filter @korajs/store build`):
 *   PW_CHROMIUM_PATH=/opt/pw-browsers/chromium node packages/store/benchmarks/browser/store-browser-bench.mjs
 * or `pnpm --filter @korajs/store test:benchmarks:browser`.
 * Prints every measurement and exits 1 if a gate fails. Never installs a browser:
 * PW_CHROMIUM_PATH (or Playwright's own resolution) must point at one.
 */
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const storeRoot = path.resolve(here, '../..')
const repoRoot = path.resolve(storeRoot, '../..')
const requireFromRoot = createRequire(path.join(repoRoot, 'package.json'))
const esbuild = createRequire(requireFromRoot.resolve('tsup'))('esbuild')
const { chromium } = createRequire(path.join(repoRoot, 'e2e/package.json'))('@playwright/test')

const FACTOR = 1.1
/** Gates: CLAUDE.md targets (x1.1). Measurements without a CLAUDE.md target are reported only. */
const GATES = [
	['OPFS insert 10,000 records (one transaction)', (r) => r.opfs.insertMs, 2_000 * FACTOR],
	['OPFS query 1,000 rows with WHERE', (r) => r.opfs.queryMs, 50 * FACTOR],
	['OPFS reactive notification p95', (r) => r.opfs.reactiveP95, 16 * FACTOR],
	['OPFS 1,000-subscription check per mutation', (r) => r.fanout.checkMs, 1 * FACTOR],
	['OPFS 1,000-subscription mutation->notify p95', (r) => r.fanout.notifyP95, 16 * FACTOR],
]

async function buildAndServe(outDir) {
	await mkdir(outDir, { recursive: true })
	const common = {
		bundle: true,
		format: 'esm',
		target: 'es2022',
		logLevel: 'error',
		absWorkingDir: here,
		nodePaths: [path.join(storeRoot, 'node_modules')],
	}
	for (const [entry, out] of [
		['harness/page-entry.js', 'page.js'],
		['harness/kora-worker-entry.js', 'kora-worker.js'],
		['harness/journal-worker-entry.js', 'journal-worker.js'],
	]) {
		await esbuild.build({
			...common,
			entryPoints: [path.join(here, entry)],
			outfile: path.join(outDir, out),
		})
	}
	await copyFile(
		path.join(storeRoot, 'node_modules/@sqlite.org/sqlite-wasm/sqlite-wasm/jswasm/sqlite3.wasm'),
		path.join(outDir, 'sqlite3.wasm'),
	)
	await writeFile(
		path.join(outDir, 'index.html'),
		'<!doctype html><meta charset=utf-8><title>kora store bench</title><script type=module src=/page.js></script>',
	)
	const types = { '.js': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm' }
	const server = createServer(async (req, res) => {
		const file = path.join(
			outDir,
			new URL(req.url ?? '/', 'http://x').pathname.replace(/^\/$/, '/index.html'),
		)
		try {
			const body = await readFile(file)
			res.writeHead(200, {
				'content-type': types[path.extname(file)] ?? 'application/octet-stream',
				'cross-origin-opener-policy': 'same-origin',
				'cross-origin-embedder-policy': 'require-corp',
			})
			res.end(body)
		} catch {
			res.writeHead(404)
			res.end()
		}
	})
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
	return { server, url: `http://127.0.0.1:${server.address().port}/` }
}

const fmt = (ms) => (ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(1)} ms`)

const outDir = path.join(os.tmpdir(), `kora-store-bench-${process.pid}`)
const { server, url } = await buildAndServe(outDir)
const browser = await chromium.launch({
	executablePath: process.env.PW_CHROMIUM_PATH || undefined,
	args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
})
let failed = false
try {
	const context = await browser.newContext()
	const page = await context.newPage()
	page.on('pageerror', (error) => console.error(`[page error] ${error.message}`))
	await page.goto(url)
	await page.waitForFunction(() => window.__ready === true)

	const results = {
		userAgent: await page.evaluate(() => navigator.userAgent),
		journal: await page.evaluate(() => window.B.journalModes()),
		opfs: await page.evaluate(() => window.B.opfs()),
		indexeddb: await page.evaluate(() => window.B.indexeddb()),
		fanout: await page.evaluate(() => window.B.fanout()),
	}

	console.log(`Browser: ${results.userAgent}`)
	console.log('\nOPFS (dedicated worker, SQLite WASM, opfs-sahpool)')
	console.log(
		`  storage: persistent=${results.opfs.persistent} mode=${results.opfs.mode} journal_mode=${results.opfs.journalMode}`,
	)
	console.log(`  open: ${fmt(results.opfs.openMs)}`)
	console.log(`  insert 10,000 (one transaction): ${fmt(results.opfs.insertMs)}`)
	console.log(`  app-path single insert: ${fmt(results.opfs.perInsertMs)} each`)
	console.log(
		`  query 1,000 rows WHERE: ${fmt(results.opfs.queryMs)} (${results.opfs.queryRows} rows)`,
	)
	console.log(
		`  reactive notification: p50 ${fmt(results.opfs.reactiveP50)}, p95 ${fmt(results.opfs.reactiveP95)}`,
	)
	console.log('\nIndexedDB fallback (in-memory SQLite WASM + snapshot to IndexedDB)')
	for (const row of results.indexeddb) {
		console.log(
			`  ${row.rows.toLocaleString('en-US')} rows: insert ${fmt(row.insertMs)}, persist snapshot ${fmt(row.persistMs)}, persist after one more write ${fmt(row.persistAfterOneWriteMs)}`,
		)
	}
	console.log('\n1,000 subscriptions over 20 collections (OPFS)')
	console.log(
		`  check per mutation ${fmt(results.fanout.checkMs)}; mutation->notify p50 ${fmt(results.fanout.notifyP50)}, p95 ${fmt(results.fanout.notifyP95)}; all 50 affected re-run p50 ${fmt(results.fanout.affectedRerunP50)}`,
	)
	console.log('\nJournal modes on opfs-sahpool (raw sqlite-wasm, 1-row write transactions)')
	for (const row of results.journal) {
		console.log(
			`  requested ${row.requested.padEnd(8)} -> actual ${row.actual.padEnd(8)} ${fmt(row.perTransactionMs)} per transaction`,
		)
	}

	console.log('\nGates (CLAUDE.md targets, x1.1)')
	for (const [name, pick, limit] of GATES) {
		const value = pick(results)
		const pass = typeof value === 'number' && value < limit
		if (!pass) failed = true
		console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: ${fmt(value)} (limit ${fmt(limit)})`)
	}
	if (results.opfs.persistent !== true) {
		failed = true
		console.log('FAIL OPFS run was not durable (fell back to memory): measurements are not OPFS')
	}
	// NEW-STORE-11: the adapter reports the journal mode it actually runs with.
	const journalReported = typeof results.opfs.journalMode === 'string'
	if (!journalReported) failed = true
	console.log(
		`${journalReported ? 'PASS' : 'FAIL'} OPFS reports its actual journal mode: ${results.opfs.journalMode}`,
	)
	if (process.env.KORA_BENCH_JSON) {
		await writeFile(process.env.KORA_BENCH_JSON, JSON.stringify(results, null, 2))
	}
	await context.close()
} finally {
	await browser.close()
	server.close()
	await rm(outDir, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)

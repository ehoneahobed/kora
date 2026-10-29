/**
 * Launcher for the browser first-sync harness (C1.0(b)). Bundles the page, its SQLite worker
 * and the orchestrator into node_modules/.cache (ignored by git and biome), then runs the orchestrator. See README.md.
 *
 * Needs the workspace packages built (`pnpm --filter korajs... build`) and a Chromium:
 * set PW_CHROMIUM_PATH, or have Playwright's own browser resolution find one. It never
 * installs a browser.
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const testRoot = path.resolve(here, '../..')
const buildDir = path.join(testRoot, 'node_modules/.cache/first-sync-browser-bench')
const requireFromTest = createRequire(path.join(testRoot, 'package.json'))
const esbuild = createRequire(requireFromTest.resolve('tsup'))('esbuild')

mkdirSync(buildDir, { recursive: true })

// The page and the SQLite worker: browser bundles with everything inlined.
const browserOptions = {
	bundle: true,
	format: 'esm',
	platform: 'browser',
	target: 'es2022',
	logLevel: 'error',
	absWorkingDir: here,
	// Node-only adapters korajs can import dynamically; the browser never reaches them.
	external: ['better-sqlite3', 'node:*', '@korajs/store/better-sqlite3', 'ws', 'postgres'],
}
await esbuild.build({
	...browserOptions,
	entryPoints: [path.join(here, 'page/page-entry.ts')],
	outfile: path.join(buildDir, 'page.js'),
})
await esbuild.build({
	...browserOptions,
	entryPoints: [path.join(here, 'page/worker-entry.ts')],
	outfile: path.join(buildDir, 'kora-worker.js'),
})
const storeRequire = createRequire(requireFromTest.resolve('@korajs/store/package.json'))
const sqliteDir = path.dirname(storeRequire.resolve('@sqlite.org/sqlite-wasm/package.json'))
copyFileSync(
	path.join(sqliteDir, 'sqlite-wasm/jswasm/sqlite3.wasm'),
	path.join(buildDir, 'sqlite3.wasm'),
)
writeFileSync(
	path.join(buildDir, 'index.html'),
	'<!doctype html><meta charset=utf-8><title>kora browser first-sync bench</title><script type=module src=/page.js></script>',
)

// The orchestrator: a Node bundle that leaves packages (workspace and npm) to Node resolution.
await esbuild.build({
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node20',
	packages: 'external',
	logLevel: 'error',
	absWorkingDir: here,
	entryPoints: [path.join(here, 'orchestrator.ts')],
	outfile: path.join(buildDir, 'orchestrator.mjs'),
})

process.env.KORA_BROWSER_BENCH_BUILD = buildDir
await import(pathToFileURL(path.join(buildDir, 'orchestrator.mjs')).href)

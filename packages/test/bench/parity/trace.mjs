/**
 * Launcher for the first-paint trace (first-visit parity, P1 attribution). Builds the Kora parity
 * app of the head (this checkout) and, optionally, of a base checkout (for example a worktree of
 * origin/main) with source maps, bundles trace.ts and runs it. It never runs the benchmark matrix.
 * See README.md, section "First-paint trace".
 *
 *   node bench/parity/trace.mjs [--base <path to a base checkout>] [--runs 3] [--cpu 1]
 *                               [--profile slow-4g|4g|broadband] [--out <dir>]
 *
 * Needs the workspace packages built in each checkout and a Chromium (PW_CHROMIUM_PATH, or the one
 * Playwright resolves). It never installs a browser.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const testRoot = path.resolve(here, '../..')
const buildDir = path.join(testRoot, 'node_modules/.cache/parity-trace')
const requireFromTest = createRequire(path.join(testRoot, 'package.json'))
const esbuild = createRequire(requireFromTest.resolve('tsup'))('esbuild')

const args = process.argv.slice(2)
const option = (name, fallback) => {
	const at = args.indexOf(`--${name}`)
	return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}

/** `<checkout>/packages/test/bench/parity/apps`, or null when the checkout has no parity apps. */
function appsDirOf(checkout) {
	const dir = path.join(checkout, 'packages/test/bench/parity/apps')
	return existsSync(path.join(dir, 'package.json')) ? dir : null
}

/** Production build of the Kora app with source maps, into `<outDir>/kora/`. */
function buildKoraApp(appsDir, outDir) {
	execFileSync('pnpm', ['exec', 'vite', 'build', '--sourcemap'], {
		cwd: appsDir,
		stdio: ['ignore', 'inherit', 'inherit'],
		env: { ...process.env, PARITY_APP: 'kora', PARITY_OUT_DIR: outDir },
	})
}

const variants = []
const headApps = appsDirOf(path.resolve(here, '../../../..'))
if (headApps === null) throw new Error('the head checkout has no parity apps')
const headOut = path.join(buildDir, 'head/apps')
mkdirSync(headOut, { recursive: true })
buildKoraApp(headApps, headOut)
variants.push({ name: 'head', staticDir: headOut })

const base = option('base', process.env.KORA_TRACE_BASE)
if (base !== undefined) {
	const baseApps = appsDirOf(path.resolve(base))
	if (baseApps === null) throw new Error(`${base} has no packages/test/bench/parity/apps`)
	const baseOut = path.join(buildDir, 'base/apps')
	mkdirSync(baseOut, { recursive: true })
	buildKoraApp(baseApps, baseOut)
	variants.push({ name: 'base', staticDir: baseOut })
}

await esbuild.build({
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node20',
	packages: 'external',
	logLevel: 'error',
	absWorkingDir: here,
	entryPoints: [path.join(here, 'trace.ts')],
	outfile: path.join(buildDir, 'trace.mjs'),
})

process.env.KORA_TRACE_VARIANTS = JSON.stringify(variants)
process.env.KORA_TRACE_RUNS = option('runs', '3')
process.env.KORA_TRACE_CPU = option('cpu', '1')
process.env.KORA_TRACE_PROFILE = option('profile', 'slow-4g')
process.env.KORA_TRACE_OUT = path.resolve(option('out', path.join(buildDir, `out-${Date.now()}`)))
await import(pathToFileURL(path.join(buildDir, 'trace.mjs')).href)

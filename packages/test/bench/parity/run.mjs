/**
 * Launcher for the first-visit parity benchmark (S0). Builds both apps with `vite build` (the
 * `@korajs/parity-bench-apps` workspace package) into node_modules/.cache, bundles the
 * orchestrator, then runs it. With KORA_PARITY_REPORT it only prints the table of saved runs.
 * See README.md.
 *
 * Needs the workspace packages built (`pnpm --filter "korajs..." --filter @korajs/cli build`)
 * and a Chromium: set PW_CHROMIUM_PATH, or have Playwright's own resolution find one. It never
 * installs a browser.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const testRoot = path.resolve(here, '../..')
const buildDir = path.join(testRoot, 'node_modules/.cache/parity-bench')
const requireFromTest = createRequire(path.join(testRoot, 'package.json'))
const esbuild = createRequire(requireFromTest.resolve('tsup'))('esbuild')

mkdirSync(buildDir, { recursive: true })

if (!process.env.KORA_PARITY_REPORT) {
	// The two apps, production builds, exactly as an app's `vite build` makes them.
	execFileSync('pnpm', ['run', 'bench:build'], {
		cwd: path.join(here, 'apps'),
		stdio: ['ignore', 'inherit', 'inherit'],
		env: { ...process.env, PARITY_OUT_DIR: path.join(buildDir, 'apps') },
	})
}

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

process.env.KORA_PARITY_BUILD = buildDir
await import(pathToFileURL(path.join(buildDir, 'orchestrator.mjs')).href)

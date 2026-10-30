/**
 * Builds one of the two parity apps (`PARITY_APP=kora` or `baseline`) into
 * `<PARITY_OUT_DIR>/<app>/`, served under `/<app>/` by the benchmark's production server.
 *
 * Both builds inline the shared probe (shared/probe.ts) at the top of `<head>`. The Kora build
 * also gets what the `react-tailwind-sync` template's build gets (minus Tailwind, which the
 * baseline would need too): the SQLite WASM copy under its unhashed name and
 * `koraServiceWorker()`, last.
 */
import { copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { koraServiceWorker } from '@korajs/cli/vite'
import react from '@vitejs/plugin-react'
import { type Plugin, defineConfig, transformWithEsbuild } from 'vite'

const here = dirname(fileURLToPath(import.meta.url))
const app = process.env.PARITY_APP === 'baseline' ? 'baseline' : 'kora'
const outDir = resolve(process.env.PARITY_OUT_DIR ?? join(here, 'dist'), app)

/** Inline the probe as the first script of the page, so it observes everything after it. */
function parityProbe(): Plugin {
	return {
		name: 'parity-probe',
		async transformIndexHtml() {
			const source = readFileSync(join(here, 'shared/probe.ts'), 'utf8')
			const { code } = await transformWithEsbuild(source, 'probe.ts', {
				format: 'iife',
				target: 'es2022',
				minify: true,
			})
			return [{ tag: 'script', children: code, injectTo: 'head-prepend' }]
		},
	}
}

/** The template's `sqliteWasmHotfix`: the hashed WASM again under `assets/sqlite3.wasm`. */
function sqliteWasmHotfix(): Plugin {
	return {
		name: 'sqlite-wasm-hotfix',
		apply: 'build',
		closeBundle() {
			const assetsDir = join(outDir, 'assets')
			if (!existsSync(assetsDir)) return
			for (const file of readdirSync(assetsDir)) {
				if (/^sqlite3-.+\.wasm$/.test(file)) {
					copyFileSync(join(assetsDir, file), join(assetsDir, 'sqlite3.wasm'))
					break
				}
			}
			const proxyFile = join(
				here,
				'node_modules/@sqlite.org/sqlite-wasm/sqlite-wasm/jswasm/sqlite3-opfs-async-proxy.js',
			)
			if (existsSync(proxyFile)) {
				copyFileSync(proxyFile, join(assetsDir, 'sqlite3-opfs-async-proxy.js'))
			}
		},
	}
}

export default defineConfig({
	root: join(here, app),
	base: `/${app}/`,
	logLevel: 'warn',
	plugins: [
		react(),
		parityProbe(),
		...(app === 'kora' ? [sqliteWasmHotfix(), koraServiceWorker()] : []),
	],
	worker: {
		format: 'es',
	},
	resolve: {
		dedupe: ['yjs', 'react', 'react-dom'],
	},
	build: {
		outDir,
		emptyOutDir: true,
	},
})

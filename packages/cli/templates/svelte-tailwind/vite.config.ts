import { copyFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { koraServiceWorker } from '@korajs/cli/vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'

function crossOriginIsolation(): Plugin {
	const embedderPolicy = process.env.KORA_COEP_POLICY || 'credentialless'

	return {
		name: 'cross-origin-isolation',
		configureServer(server) {
			server.middlewares.use((_req, res, next) => {
				res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
				res.setHeader('Cross-Origin-Embedder-Policy', embedderPolicy)
				next()
			})
		},
		configurePreviewServer(server) {
			server.middlewares.use((_req, res, next) => {
				res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
				res.setHeader('Cross-Origin-Embedder-Policy', embedderPolicy)
				next()
			})
		},
	}
}

function sqliteWasmHotfix(): Plugin {
	return {
		name: 'sqlite-wasm-hotfix',
		apply: 'build',
		closeBundle() {
			const assetsDir = resolve('dist', 'assets')
			if (!existsSync(assetsDir)) return
			for (const file of readdirSync(assetsDir)) {
				if (/^sqlite3-.+\.wasm$/.test(file)) {
					copyFileSync(join(assetsDir, file), join(assetsDir, 'sqlite3.wasm'))
					break
				}
			}
		},
	}
}

// koraServiceWorker() (build only, keep it last): precaches the built app shell so the
// app opens offline, with a "new version available" reload prompt. See @korajs/cli/vite.
export default defineConfig({
	plugins: [
		svelte(),
		tailwindcss(),
		crossOriginIsolation(),
		sqliteWasmHotfix(),
		koraServiceWorker(),
	],
	worker: { format: 'es' },
	optimizeDeps: {
		exclude: ['@sqlite.org/sqlite-wasm', '@korajs/store'],
		include: ['yjs'],
	},
	resolve: { dedupe: ['yjs'] },
})

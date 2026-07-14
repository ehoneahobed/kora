import { copyFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'

function crossOriginIsolation(): Plugin {
	return {
		name: 'cross-origin-isolation',
		configureServer(server) {
			server.middlewares.use((_req, res, next) => {
				res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
				res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
				next()
			})
		},
		configurePreviewServer(server) {
			server.middlewares.use((_req, res, next) => {
				res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
				res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
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

export default defineConfig({
	plugins: [svelte(), crossOriginIsolation(), sqliteWasmHotfix()],
	worker: { format: 'es' },
	optimizeDeps: {
		exclude: ['@sqlite.org/sqlite-wasm', '@korajs/store'],
		include: ['yjs'],
	},
	resolve: { dedupe: ['yjs'] },
})

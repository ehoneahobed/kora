import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'

const fixtureDir = path.dirname(fileURLToPath(import.meta.url))

/**
 * COOP/COEP headers required for SharedArrayBuffer (SQLite WASM + OPFS).
 * Without these, the worker hangs on `open` in headless Chromium.
 */
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
	}
}

export default defineConfig({
	plugins: [react(), crossOriginIsolation()],
	worker: {
		format: 'es',
	},
	optimizeDeps: {
		exclude: ['@sqlite.org/sqlite-wasm', '@korajs/store', '@korajs/store/sqlite-wasm/worker'],
	},
	resolve: {
		alias: {
			'@korajs/tauri': path.join(fixtureDir, 'src/stubs/tauri-stub.ts'),
		},
	},
})

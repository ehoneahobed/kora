import { copyFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
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

			const proxyFile = resolve(
				'node_modules',
				'@sqlite.org',
				'sqlite-wasm',
				'sqlite-wasm',
				'jswasm',
				'sqlite3-opfs-async-proxy.js',
			)
			if (existsSync(proxyFile)) {
				copyFileSync(proxyFile, join(assetsDir, 'sqlite3-opfs-async-proxy.js'))
			}
		},
	}
}

export default defineConfig({
	plugins: [vue(), crossOriginIsolation(), sqliteWasmHotfix()],
	worker: {
		format: 'es',
	},
	optimizeDeps: {
		exclude: ['@sqlite.org/sqlite-wasm', '@korajs/store'],
		include: ['yjs'],
	},
	resolve: {
		dedupe: ['yjs'],
	},
	server: {
		allowedHosts: true,
		watch: {
			ignored: ['**/.kora/**', '**/*.db', '**/*.db-shm', '**/*.db-wal'],
		},
		proxy: {
			'/kora-sync': {
				target: 'ws://localhost:3001',
				ws: true,
				rewriteWsOrigin: true,
			},
			'/auth': {
				target: 'http://localhost:3001',
				changeOrigin: true,
			},
		},
	},
})

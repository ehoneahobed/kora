import { existsSync, readdirSync, copyFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'

/**
 * Adds Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers
 * required for SharedArrayBuffer. Without these headers, OPFS SAH Pool VFS
 * cannot be used and SQLite WASM falls back to in-memory storage (no persistence).
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
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
        next()
      })
    },
  }
}

/**
 * Fixes sqlite3 WASM assets in production builds:
 * 1. Copies the hashed sqlite3.wasm to an unhashed name so Emscripten's locateFile works
 * 2. Copies sqlite3-opfs-async-proxy.js from node_modules (not bundled by Vite since
 *    sqlite3 loads it dynamically) so the full OPFS VFS can initialize without errors
 */
function sqliteWasmHotfix(): Plugin {
  return {
    name: 'sqlite-wasm-hotfix',
    apply: 'build',
    closeBundle() {
      const assetsDir = resolve('dist', 'assets')
      if (!existsSync(assetsDir)) return

      // Copy hashed sqlite3.wasm to unhashed name
      for (const file of readdirSync(assetsDir)) {
        if (/^sqlite3-.+\.wasm$/.test(file)) {
          copyFileSync(join(assetsDir, file), join(assetsDir, 'sqlite3.wasm'))
          break
        }
      }

      // Copy OPFS async proxy worker (dynamically loaded by sqlite3, not detected by Vite)
      const proxyFile = resolve('node_modules', '@sqlite.org', 'sqlite-wasm', 'sqlite-wasm', 'jswasm', 'sqlite3-opfs-async-proxy.js')
      if (existsSync(proxyFile)) {
        copyFileSync(proxyFile, join(assetsDir, 'sqlite3-opfs-async-proxy.js'))
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), crossOriginIsolation(), sqliteWasmHotfix()],
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
})

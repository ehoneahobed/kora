import { defineConfig } from 'tsup'

export default defineConfig({
	entry: [
		'src/index.ts',
		'src/adapters/better-sqlite3.ts',
		'src/adapters/sqlite-wasm.ts',
		'src/adapters/sqlite-wasm-worker.ts',
		'src/adapters/indexeddb.ts',
	],
	format: ['esm', 'cjs'],
	dts: true,
	sourcemap: true,
	clean: true,
	external: ['better-sqlite3', '@sqlite.org/sqlite-wasm'],
})

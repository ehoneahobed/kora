import { defineConfig } from 'tsup'

export default defineConfig({
	entry: [
		'src/index.ts',
		'src/internal.ts',
		'src/adapters/better-sqlite3.ts',
		'src/adapters/sqlite-wasm.ts',
		'src/adapters/sqlite-wasm-worker.ts',
		'src/adapters/indexeddb.ts',
		'src/blob-fs.ts',
		'src/lite.ts',
	],
	format: ['esm', 'cjs'],
	// CommonJS shares code between entries too: without it each entry holds its own copy of every
	// class, and `instanceof KoraError` fails across the lite and full entries.
	splitting: true,
	dts: true,
	sourcemap: true,
	clean: true,
	external: ['better-sqlite3', '@sqlite.org/sqlite-wasm'],
})

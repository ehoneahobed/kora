import { defineConfig } from 'tsup'

export default defineConfig({
	entry: ['src/index.ts', 'src/adapters/better-sqlite3.ts'],
	format: ['esm', 'cjs'],
	dts: true,
	sourcemap: true,
	clean: true,
	external: ['better-sqlite3'],
})

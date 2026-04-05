import { defineConfig } from 'tsup'

export default defineConfig({
	entry: ['src/index.ts', 'src/internal.ts'],
	format: ['esm', 'cjs'],
	dts: true,
	sourcemap: true,
	clean: true,
	external: ['ws', 'better-sqlite3', 'drizzle-orm'],
})

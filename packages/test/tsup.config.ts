import { defineConfig } from 'tsup'

export default defineConfig({
	entry: { index: 'src/index.ts', playwright: 'src/playwright/index.ts' },
	format: ['esm', 'cjs'],
	dts: true,
	sourcemap: true,
	clean: true,
	external: ['playwright-core', 'better-sqlite3', 'korajs', 'korajs/testing'],
})

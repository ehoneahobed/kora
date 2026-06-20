import { defineConfig } from 'tsup'

export default defineConfig({
	entry: ['src/index.ts', 'src/config.ts', 'src/testing.ts'],
	format: ['esm', 'cjs'],
	dts: true,
	sourcemap: true,
	clean: true,
	external: ['@korajs/tauri'],
})

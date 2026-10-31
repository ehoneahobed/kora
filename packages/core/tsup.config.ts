import { defineConfig } from 'tsup'

export default defineConfig({
	entry: ['src/index.ts', 'src/internal.ts', 'src/bindings/index.ts', 'src/lite.ts'],
	format: ['esm', 'cjs'],
	dts: true,
	sourcemap: true,
	clean: true,
})

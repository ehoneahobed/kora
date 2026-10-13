import { defineConfig } from 'tsup'

export default defineConfig({
	entry: ['src/index.ts', 'src/server.ts', 'src/client.ts', 'src/react.ts'],
	format: ['esm', 'cjs'],
	dts: true,
	sourcemap: true,
	clean: true,
	external: ['react', '@korajs/react', '@korajs/server'],
	shims: true,
})

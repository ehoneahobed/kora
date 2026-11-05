import { defineConfig } from 'tsup'

export default defineConfig({
	entry: ['src/index.ts', 'src/internal.ts', 'src/protobuf.ts', 'src/lite.ts'],
	format: ['esm', 'cjs'],
	// CommonJS shares code between entries too: without it each entry holds its own copy of every
	// class, and `instanceof KoraError` fails across the lite and full entries.
	splitting: true,
	dts: true,
	sourcemap: true,
	clean: true,
})

import { defineConfig } from 'tsup'

export default defineConfig({
	entry: [
		'src/index.ts',
		'src/internal.ts',
		'src/bindings/index.ts',
		'src/lite.ts',
		'src/access/access-compiler.ts',
	],
	format: ['esm', 'cjs'],
	// CommonJS shares code between entries too: without it each entry holds its own copy of every
	// class, and `instanceof KoraError` fails across the lite and full entries.
	splitting: true,
	dts: true,
	sourcemap: true,
	clean: true,
})

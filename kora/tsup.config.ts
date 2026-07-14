import { defineConfig } from 'tsup'

export default defineConfig({
	entry: [
		'src/index.ts',
		'src/config.ts',
		'src/testing.ts',
		'src/react.ts',
		'src/vue.ts',
		'src/svelte.ts',
	],
	format: ['esm', 'cjs'],
	dts: true,
	sourcemap: true,
	clean: true,
	external: [
		'@korajs/tauri',
		'@korajs/react',
		'@korajs/vue',
		'@korajs/svelte',
		'react',
		'vue',
		'svelte',
	],
})

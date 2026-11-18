import { defineConfig } from 'tsup'

const external = [
	'@korajs/tauri',
	'@korajs/react',
	'@korajs/vue',
	'@korajs/svelte',
	'react',
	'vue',
	'svelte',
]

const shared = { format: ['esm', 'cjs'] as const, dts: true, sourcemap: true, external }

/**
 * The framework subpaths (`korajs/react`, `/vue`, `/svelte`) each get their own build: built
 * together, the declaration bundler hoists every entry's external imports into one shared set,
 * and react.d.ts then imported @korajs/vue and @korajs/svelte, optional peers a React app does
 * not install (dist-declarations.test.ts). tsup runs the configs in parallel, so none of them
 * cleans dist (one would delete the others' output): the build script removes it first.
 */
export default defineConfig([
	{
		...shared,
		entry: ['src/index.ts', 'src/config.ts', 'src/testing.ts'],
		clean: false,
	},
	...(['react', 'vue', 'svelte'] as const).map((framework) => ({
		...shared,
		entry: [`src/${framework}.ts`],
		clean: false,
	})),
])

import { defineConfig } from 'tsup'

export default defineConfig({
	entry: ['src/index.ts', 'src/bin.ts', 'src/create.ts'],
	format: ['esm', 'cjs'],
	dts: { entry: ['src/index.ts'] },
	sourcemap: true,
	clean: true,
	external: [
		'@korajs/store',
		'@korajs/store/better-sqlite3',
		'@korajs/core',
		'@korajs/core/internal',
		'@korajs/merge',
		'@korajs/sync',
		'@korajs/test',
		'@korajs/server',
		'@korajs/server/internal',
		'korajs',
		'korajs/testing',
		'better-sqlite3',
	],
	banner: ({ format }) => {
		if (format === 'esm') {
			return { js: '#!/usr/bin/env node' }
		}
		return {}
	},
})

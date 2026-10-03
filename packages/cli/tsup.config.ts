import { defineConfig } from 'tsup'

export default defineConfig({
	entry: {
		index: 'src/index.ts',
		bin: 'src/bin.ts',
		create: 'src/create.ts',
		// Build-time Vite plugin for scaffolded apps (offline app shell, NEW-DX-3).
		vite: 'src/vite/service-worker.ts',
	},
	format: ['esm', 'cjs'],
	dts: { entry: { index: 'src/index.ts', vite: 'src/vite/service-worker.ts' } },
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

import { defineConfig } from 'tsup'

export default defineConfig({
	entry: ['src/index.ts', 'src/bin.ts', 'src/create.ts'],
	format: ['esm', 'cjs'],
	dts: { entry: ['src/index.ts'] },
	sourcemap: true,
	clean: true,
	banner: ({ format }) => {
		if (format === 'esm') {
			return { js: '#!/usr/bin/env node' }
		}
		return {}
	},
})

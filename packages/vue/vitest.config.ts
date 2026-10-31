import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import shared from '../../vitest.shared'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default mergeConfig(
	shared,
	defineConfig({
		test: {
			name: '@korajs/vue',
			root: __dirname,
			environment: 'happy-dom',
			include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
		},
		resolve: {
			// The CLI's Vue templates have no node_modules; their tests resolve `vue` from here.
			alias: [{ find: /^vue$/, replacement: `${__dirname}/node_modules/vue` }],
		},
	}),
)

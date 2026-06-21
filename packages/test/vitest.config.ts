import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import shared from '../../vitest.shared'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default mergeConfig(
	shared,
	defineConfig({
		resolve: {
			alias: {
				'korajs/testing': resolve(__dirname, '../../kora/src/testing.ts'),
			},
		},
		test: {
			name: '@korajs/test',
			root: __dirname,
			include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
		},
	}),
)

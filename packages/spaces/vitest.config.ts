import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import shared from '../../vitest.shared'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default mergeConfig(
	shared,
	defineConfig({
		test: {
			name: '@korajs/spaces',
			root: __dirname,
			include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
			testTimeout: 30_000,
		},
	}),
)

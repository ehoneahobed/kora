import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import shared from '../../vitest.shared'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default mergeConfig(
	shared,
	defineConfig({
		test: {
			name: '@korajs/auth',
			root: __dirname,
			include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
			// Password hashing and webhook retry tests exceed 5s under parallel turbo load
			testTimeout: 30_000,
		},
	}),
)

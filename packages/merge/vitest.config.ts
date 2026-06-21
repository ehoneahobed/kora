import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import shared from '../../vitest.shared'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default mergeConfig(
	shared,
	defineConfig({
		test: {
			name: '@korajs/merge',
			root: __dirname,
			include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
			// Performance gates run via `pnpm test:benchmarks`, not default `pnpm test`.
			exclude: ['src/benchmarks/**'],
		},
	}),
)

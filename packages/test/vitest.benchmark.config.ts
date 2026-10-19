import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import shared from '../../vitest.shared'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Cross-package benchmarks (first sync, docs/design/fast-first-sync.md). Not part of
 * `pnpm test`: run with `pnpm --filter @korajs/test bench:first-sync`.
 */
export default mergeConfig(
	shared,
	defineConfig({
		resolve: {
			alias: {
				'korajs/testing': resolve(__dirname, '../../kora/src/testing.ts'),
			},
		},
		test: {
			name: '@korajs/test-bench',
			root: __dirname,
			include: ['bench/**/*.bench.test.ts'],
			testTimeout: 3_600_000,
			hookTimeout: 600_000,
			fileParallelism: false,
		},
	}),
)

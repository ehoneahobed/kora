import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import shared from '../../vitest.shared'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Server benchmarks. Not part of `pnpm test`: run with
 * `pnpm --filter @korajs/server bench:scope-in` (set KORA_PG_TEST_URL for Postgres).
 */
export default mergeConfig(
	shared,
	defineConfig({
		test: {
			name: '@korajs/server-bench',
			root: __dirname,
			include: ['bench/**/*.bench.test.ts'],
			testTimeout: 1_800_000,
			hookTimeout: 1_800_000,
			fileParallelism: false,
		},
	}),
)

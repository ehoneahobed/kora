import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configDefaults, defineConfig, mergeConfig } from 'vitest/config'
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
			// The hop matrix of the delivery position has its own job (ci.yml, delivery-hops) and
			// its own script (`test:hops`, which sets KORA_RUN_HOPS=1); it is not part of `pnpm test`.
			exclude:
				process.env.KORA_RUN_HOPS === '1'
					? configDefaults.exclude
					: [...configDefaults.exclude, 'tests/staged-replication-hops.test.ts'],
			// Multi-device convergence tests run whole simulated fleets; the timeout is a hang
			// guard only (the tests use deterministic clocks and mock transports), so it must not
			// trip on a loaded CI machine. Several took ~4.5s against the 5s default.
			testTimeout: 30_000,
		},
	}),
)

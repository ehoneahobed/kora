import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import shared from '../../vitest.shared'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default mergeConfig(
	shared,
	defineConfig({
		test: {
			name: '@korajs/server',
			root: __dirname,
			include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
			// production-server.test.ts binds real HTTP listeners and makes real
			// fetch() round trips. That's fast in isolation, but under
			// `pnpm test`'s `turbo run test --concurrency=6` several packages'
			// worker pools compete for the same cores, and server.start()/fetch()
			// can miss Vitest's default 5s timeout even though nothing is
			// actually hung, same class of load-induced flake already worked
			// around in packages/auth/vitest.config.ts.
			testTimeout: 30_000,
		},
	}),
)

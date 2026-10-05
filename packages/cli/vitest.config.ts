import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import shared from '../../vitest.shared'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default mergeConfig(
	shared,
	defineConfig({
		test: {
			name: '@korajs/cli',
			root: __dirname,
			include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
			// CLI tests scaffold projects, spawn processes and boot sync servers. The timeouts
			// are hang guards only; the 5s/10s defaults tripped on loaded CI runners.
			testTimeout: 30_000,
			hookTimeout: 60_000,
		},
	}),
)

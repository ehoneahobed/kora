import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		coverage: {
			provider: 'v8',
			thresholds: {
				branches: 80,
				functions: 80,
				lines: 80,
				statements: 80,
			},
			exclude: ['node_modules', 'dist', '**/*.test.ts', 'tests/fixtures/**'],
		},
		environment: 'node',
	},
})

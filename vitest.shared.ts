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
		passWithNoTests: true,
		// Cap each package's own worker pool. Vitest's default (unset) maxForks
		// is the machine's CPU count, fine for one package running alone, but
		// `pnpm test` runs `turbo run test --concurrency=6`, so up to 6 packages
		// each try to claim every core simultaneously. That multiplicative
		// over-subscription (6 packages x N cores of forked workers) is what
		// starves the OS on ordinary laptops: tinypool workers get killed
		// (`Worker exited unexpectedly`) and sibling workers whose pipe partner
		// just died follow with `write EPIPE`. Bounding forks per package keeps
		// total concurrent worker processes sane regardless of how many
		// packages turbo runs at once.
		poolOptions: {
			forks: {
				maxForks: 2,
			},
		},
	},
})

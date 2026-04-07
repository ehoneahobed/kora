import { defineConfig } from 'vitest/config'

/**
 * Root Vitest workspace configuration.
 *
 * This ensures `vitest run` from the monorepo root executes each package with
 * its own config (including `@korajs/react` using jsdom), instead of falling
 * back to a single default environment.
 */
export default defineConfig({
	test: {
		projects: ['packages/*/vitest.config.ts', 'kora/vitest.config.ts'],
	},
})

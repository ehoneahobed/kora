import { defineConfig } from 'vitest/config'

/**
 * Root Vitest workspace configuration.
 *
 * Each package defines its own project config with scoped include patterns
 * to ensure tests only run under the correct environment.
 */
export default defineConfig({
	test: {
		projects: ['packages/*', 'kora'],
	},
})

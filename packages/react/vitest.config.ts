import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import shared from '../../vitest.shared'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default mergeConfig(
	shared,
	defineConfig({
		test: {
			name: '@korajs/react',
			root: __dirname,
			environment: 'jsdom',
			include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
		},
		resolve: {
			// The CLI's React templates import `@korajs/react`; their tests render them against
			// this package's source.
			alias: [{ find: /^@korajs\/react$/, replacement: `${__dirname}/src/index.ts` }],
			// ...and resolve `react` from this package (the templates have no node_modules).
			dedupe: ['react', 'react-dom'],
		},
		esbuild: { jsx: 'automatic' },
	}),
)

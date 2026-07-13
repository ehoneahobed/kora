import { svelte } from '@sveltejs/vite-plugin-svelte'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import shared from '../../vitest.shared'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default mergeConfig(
	shared,
	defineConfig({
		plugins: [
			svelte({
				hot: !process.env.VITEST,
			}),
		],
		resolve: {
			conditions: ['browser'],
		},
		test: {
			name: '@korajs/svelte',
			root: __dirname,
			environment: 'happy-dom',
			include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
		},
	}),
)

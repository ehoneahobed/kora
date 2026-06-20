import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import shared from '../vitest.shared'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default mergeConfig(
	shared,
	defineConfig({
		resolve: {
			alias: {
				'@korajs/test': resolve(__dirname, '../packages/test/src/index.ts'),
				'@korajs/auth/server': resolve(__dirname, '../packages/auth/src/server.ts'),
				'@korajs/auth': resolve(__dirname, '../packages/auth/src/index.ts'),
				'@korajs/server/internal': resolve(__dirname, '../packages/server/src/internal.ts'),
				'@korajs/store/internal': resolve(__dirname, '../packages/store/src/internal.ts'),
				'korajs/testing': resolve(__dirname, './src/testing.ts'),
			},
		},
		test: {
			name: 'korajs',
			root: __dirname,
			include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
		},
	}),
)

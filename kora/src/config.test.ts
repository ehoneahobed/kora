import { describe, expect, test } from 'vitest'
import { defineConfig } from './config'

describe('defineConfig', () => {
	test('returns config unchanged', () => {
		const config = defineConfig({
		schema: './src/schema.ts',
		dev: {
			port: 5173,
			sync: { enabled: true, port: 3001, store: { type: 'sqlite', filename: './kora-sync.db' } },
			watch: { enabled: true, debounceMs: 300 },
		},
	})

		expect(config.schema).toBe('./src/schema.ts')
		expect(config.dev?.port).toBe(5173)
		expect(config.dev?.sync).toEqual({
			enabled: true,
			port: 3001,
			store: { type: 'sqlite', filename: './kora-sync.db' },
		})
	})

	test('supports postgres managed sync configuration', () => {
		const config = defineConfig({
			dev: {
				sync: {
					enabled: true,
					store: {
						type: 'postgres',
						connectionString: 'postgres://user:pass@localhost:5432/kora',
					},
				},
			},
		})

		expect(config.dev?.sync).toEqual({
			enabled: true,
			store: {
				type: 'postgres',
				connectionString: 'postgres://user:pass@localhost:5432/kora',
			},
		})
	})
})

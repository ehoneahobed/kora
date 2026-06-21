import { KoraError, SchemaValidationError, defineSchema, t } from '@korajs/core'
import { describe, expect, it } from 'vitest'
import type { KoraConfig } from './types'
import { validateCreateAppConfig } from './validate-config'

const validSchema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
			},
		},
	},
})

function baseConfig(overrides: Partial<KoraConfig> = {}): KoraConfig {
	return {
		schema: validSchema,
		...overrides,
	}
}

describe('validateCreateAppConfig', () => {
	it('accepts a minimal valid config', () => {
		expect(() => validateCreateAppConfig(baseConfig())).not.toThrow()
	})

	it('rejects missing schema', () => {
		expect(() =>
			validateCreateAppConfig({ schema: undefined as unknown as KoraConfig['schema'] }),
		).toThrow(SchemaValidationError)
	})

	it('rejects empty collections', () => {
		const empty = { version: 1, collections: {} } as typeof validSchema
		expect(() => validateCreateAppConfig(baseConfig({ schema: empty }))).toThrow(
			SchemaValidationError,
		)
	})

	it('rejects invalid sync URL for websocket transport', () => {
		expect(() =>
			validateCreateAppConfig(
				baseConfig({
					sync: { url: 'not-a-url', transport: 'websocket' },
				}),
			),
		).toThrow(KoraError)
	})

	it('accepts valid wss URL', () => {
		expect(() =>
			validateCreateAppConfig(
				baseConfig({
					sync: { url: 'wss://example.com/kora' },
				}),
			),
		).not.toThrow()
	})

	it('accepts valid https URL for http transport', () => {
		expect(() =>
			validateCreateAppConfig(
				baseConfig({
					sync: { url: 'https://example.com/kora', transport: 'http' },
				}),
			),
		).not.toThrow()
	})
})

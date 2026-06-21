import { describe, expect, test } from 'vitest'
import {
	SCHEMA_MISMATCH_PREFIX,
	isClientSchemaVersionSupported,
	isSchemaMismatchReject,
} from './schema-version'

describe('schema-version protocol', () => {
	test('isSchemaMismatchReject detects SCHEMA_MISMATCH prefix', () => {
		expect(isSchemaMismatchReject(`${SCHEMA_MISMATCH_PREFIX}: out of range`)).toBe(true)
		expect(isSchemaMismatchReject('AUTH_FAILED')).toBe(false)
		expect(isSchemaMismatchReject(undefined)).toBe(false)
	})

	test('isClientSchemaVersionSupported checks inclusive range', () => {
		const range = { min: 1, max: 3 }
		expect(isClientSchemaVersionSupported(1, range)).toBe(true)
		expect(isClientSchemaVersionSupported(3, range)).toBe(true)
		expect(isClientSchemaVersionSupported(0, range)).toBe(false)
		expect(isClientSchemaVersionSupported(4, range)).toBe(false)
	})
})

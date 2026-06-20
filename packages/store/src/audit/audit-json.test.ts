import { describe, expect, test } from 'vitest'
import {
	auditJsonReplacer,
	auditJsonReviver,
	deserializeAuditJson,
	serializeAuditJson,
} from './audit-json'

describe('audit-json', () => {
	test('round-trips Uint8Array values', () => {
		const bytes = new Uint8Array([1, 2, 3, 255])
		const json = serializeAuditJson({ notes: bytes })
		const parsed = deserializeAuditJson<{ notes: Uint8Array }>(json)
		expect(parsed.notes).toBeInstanceOf(Uint8Array)
		expect(Array.from(parsed.notes)).toEqual([1, 2, 3, 255])
	})

	test('replacer and reviver are symmetric for plain objects', () => {
		const value = { title: 'hello', count: 2 }
		const roundTrip = JSON.parse(JSON.stringify(value, auditJsonReplacer), auditJsonReviver)
		expect(roundTrip).toEqual(value)
	})
})

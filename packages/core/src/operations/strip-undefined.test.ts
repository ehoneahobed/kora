import { describe, expect, test } from 'vitest'
import { HybridLogicalClock } from '../clock/hlc'
import { defineSchema } from '../schema/define'
import { t } from '../schema/types'
import { validateRecord } from '../schema/validation'
import { computeOperationId } from './content-hash'
import { createOperation, verifyOperationId } from './operation'
import { stripUndefinedMembers } from './strip-undefined'

describe('stripUndefinedMembers (RT-72)', () => {
	test('removes undefined members deeply and nulls undefined array elements, like JSON', () => {
		const value = { a: 1, b: undefined, c: { d: undefined, e: [1, undefined, { f: undefined }] } }
		const stripped = stripUndefinedMembers(value)
		expect(stripped).toEqual({ a: 1, c: { e: [1, null, {}] } })
		expect(stripped).toEqual(JSON.parse(JSON.stringify(value)))
		expect(Object.keys(stripped)).toEqual(['a', 'c'])
	})

	test('returns the same reference when nothing changes, and keeps binary values', () => {
		const bytes = new Uint8Array([1, 2])
		const value = { a: 1, b: [1, 2], c: { bytes } }
		expect(stripUndefinedMembers(value)).toBe(value)
		expect(stripUndefinedMembers(null)).toBeNull()
		const changed = stripUndefinedMembers({ c: { bytes }, d: undefined })
		expect(changed.c.bytes).toBe(bytes)
	})
})

describe('one canonical content for hashing and storage (RT-72)', () => {
	test('createOperation stores and hashes data without undefined members', async () => {
		const clock = new HybridLogicalClock('device-a')
		const op = await createOperation(
			{
				nodeId: 'device-a',
				type: 'insert',
				collection: 'notes',
				recordId: 'r1',
				data: { title: 'x', meta: { a: 1, b: undefined } },
				previousData: null,
				sequenceNumber: 1,
				causalDeps: [],
				schemaVersion: 1,
			},
			clock,
		)
		expect(op.data).toEqual({ title: 'x', meta: { a: 1 } })
		expect('b' in (op.data?.meta as Record<string, unknown>)).toBe(false)
		// The JSON form (op log, wire) verifies.
		expect(await verifyOperationId(JSON.parse(JSON.stringify(op)))).toBe(true)
	})

	test('a version-2 hash treats an undefined member as absent; version 1 keeps the beta.13 form', async () => {
		const base = {
			nodeId: 'device-a',
			type: 'insert' as const,
			collection: 'notes',
			recordId: 'r1',
			previousData: null,
			timestamp: { wallTime: 1, logical: 0, nodeId: 'device-a' },
			sequenceNumber: 1,
			causalDeps: [],
			schemaVersion: 1,
		}
		const withUndefined = { ...base, data: { a: 1, b: undefined } }
		const absent = { ...base, data: { a: 1 } }
		const asNull = { ...base, data: { a: 1, b: null } }
		expect(await computeOperationId(withUndefined, 2)).toBe(await computeOperationId(absent, 2))
		expect(await computeOperationId(withUndefined, 2)).not.toBe(await computeOperationId(asNull, 2))
		// Version 1 is beta.13's hash: an undefined member hashes as null.
		expect(await computeOperationId(withUndefined, 1)).toBe(await computeOperationId(asNull, 1))
	})

	test('validateRecord drops undefined members of object values, on insert and update', () => {
		const schema = defineSchema({
			version: 1,
			collections: {
				notes: {
					fields: {
						title: t.string(),
						meta: t.object({ a: t.number().optional(), b: t.string().optional() }).optional(),
					},
				},
			},
		})
		const def = schema.collections.notes
		if (def === undefined) throw new Error('missing collection')
		const inserted = validateRecord(
			'notes',
			def,
			{ title: 'x', meta: { a: 1, b: undefined } },
			'insert',
		)
		expect(inserted).toEqual({ title: 'x', meta: { a: 1 } })
		expect('b' in (inserted.meta as Record<string, unknown>)).toBe(false)
		const updated = validateRecord('notes', def, { meta: { a: 2, b: undefined } }, 'update')
		expect('b' in (updated.meta as Record<string, unknown>)).toBe(false)
	})
})

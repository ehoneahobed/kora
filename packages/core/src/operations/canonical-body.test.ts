import { fc, test as propTest } from '@fast-check/vitest'
import { describe, expect, test } from 'vitest'
import { HybridLogicalClock } from '../clock/hlc'
import { defineSchema } from '../schema/define'
import { t } from '../schema/types'
import { validateRecord } from '../schema/validation'
import type { OperationInput } from '../types'
import {
	NonCanonicalValueError,
	canonicalValue,
	canonicalizeLegacyOperation,
	canonicalizeOperationBody,
} from './canonical-body'
import { computeOperationId } from './content-hash'
import { createOperation, verifyOperationId } from './operation'

function input(overrides: Partial<OperationInput>): OperationInput {
	return {
		nodeId: 'device-a',
		type: 'insert',
		collection: 'notes',
		recordId: 'r1',
		data: { title: 'x' },
		previousData: null,
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

describe('canonicalizeOperationBody: the table', () => {
	test('undefined: absent in an insert and inside values; null (a clear) at an update top level', () => {
		const inserted = canonicalizeOperationBody(
			input({ data: { a: 1, b: undefined, c: { d: undefined, e: [1, undefined] } } }),
		)
		expect(inserted.data).toEqual({ a: 1, c: { e: [1, null] } })
		expect(Object.keys(inserted.data ?? {})).toEqual(['a', 'c'])
		const updated = canonicalizeOperationBody(
			input({
				type: 'update',
				data: { assignee: undefined, meta: { a: undefined } },
				previousData: { assignee: 'bob', meta: undefined },
			}),
		)
		expect(updated.data).toEqual({ assignee: null, meta: {} })
		expect(updated.previousData).toEqual({ assignee: 'bob', meta: null })
	})

	test('Date becomes its ISO string; -0 becomes 0; binary becomes the tagged op-log form', () => {
		const body = canonicalizeOperationBody(
			input({
				data: { when: { at: new Date(5) }, n: -0, bytes: new Uint8Array([1, 2, 3]) },
			}),
		)
		expect(body.data).toEqual({
			when: { at: '1970-01-01T00:00:00.005Z' },
			n: 0,
			bytes: { $koraBytes: 'AQID' },
		})
		expect(Object.is((body.data as { n: number }).n, 0)).toBe(true)
	})

	test.each([
		['Map', new Map([['a', 1]])],
		['Set', new Set([1])],
		['class instance', new (class Foo {})()],
		['BigInt', BigInt(1)],
		['NaN', Number.NaN],
		['Infinity', Number.POSITIVE_INFINITY],
		['function', () => 1],
		['symbol', Symbol('s')],
		['invalid Date', new Date(Number.NaN)],
		['toJSON object', { toJSON: () => 'x' }],
		['RegExp', /x/],
	])('%s is refused with a NonCanonicalValueError naming the path', (_label, value) => {
		let caught: unknown = null
		try {
			canonicalizeOperationBody(input({ data: { meta: { deep: value } } }))
		} catch (error) {
			caught = error
		}
		expect(caught).toBeInstanceOf(NonCanonicalValueError)
		expect((caught as NonCanonicalValueError).path).toBe('notes/r1.meta.deep')
		expect((caught as NonCanonicalValueError).code).toBe('NON_CANONICAL_VALUE')
	})

	test('a circular value and an array hole are refused', () => {
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		expect(() => canonicalValue(cyclic, 'x')).toThrow(NonCanonicalValueError)
		const holey: unknown[] = [1]
		holey[2] = 3
		expect(() => canonicalValue(holey, 'x')).toThrow(NonCanonicalValueError)
	})

	test('a canonical body is returned unchanged (same reference); canonicalization is idempotent', () => {
		const body = input({ data: { a: 1, b: [1, { c: 'x' }] } })
		expect(canonicalizeOperationBody(body)).toBe(body)
		const once = canonicalizeOperationBody(input({ data: { a: new Date(1), b: undefined } }))
		expect(canonicalizeOperationBody(once)).toBe(once)
	})
})

describe('createOperation hashes and carries the canonical body', () => {
	test('an update of only undefined fields is a clear, and its JSON form verifies (RT-80)', async () => {
		const op = await createOperation(
			input({ type: 'update', data: { assignee: undefined }, previousData: { assignee: 'bob' } }),
			new HybridLogicalClock('device-a'),
		)
		expect(op.data).toEqual({ assignee: null })
		expect(await verifyOperationId(JSON.parse(JSON.stringify(op)))).toBe(true)
	})

	test('a Date inside a json value is carried as its ISO string; its JSON form verifies (RT-79)', async () => {
		const op = await createOperation(
			input({ data: { extra: { when: new Date(5) } } }),
			new HybridLogicalClock('device-a'),
		)
		expect(op.data).toEqual({ extra: { when: '1970-01-01T00:00:00.005Z' } })
		expect(await verifyOperationId(JSON.parse(JSON.stringify(op)))).toBe(true)
	})

	test('createOperation refuses a Map instead of silently storing {}', async () => {
		await expect(
			createOperation(input({ data: { extra: new Map() } }), new HybridLogicalClock('device-a')),
		).rejects.toThrow(NonCanonicalValueError)
	})

	test('version 1 keeps the beta.12 form (undefined hashes as null)', async () => {
		const base = {
			...input({}),
			timestamp: { wallTime: 1, logical: 0, nodeId: 'device-a' },
		}
		expect(await computeOperationId({ ...base, data: { a: 1, b: undefined } }, 1)).toBe(
			await computeOperationId({ ...base, data: { a: 1, b: null } }, 1),
		)
	})

	test('verifyOperationId answers false (never throws) for a body with no canonical form', async () => {
		const op = await createOperation(input({}), new HybridLogicalClock('device-a'))
		expect(await verifyOperationId({ ...op, data: { x: new Map() } })).toBe(false)
	})
})

describe('canonicalizeLegacyOperation (RT-71, RT-83)', () => {
	test('a version-1 update: every previousData key absent from data is a clear', () => {
		const op = {
			type: 'update' as const,
			data: { title: 'y' },
			previousData: { title: 'x', assignee: 'bob' },
		}
		expect(canonicalizeLegacyOperation(op).data).toEqual({ title: 'y', assignee: null })
		// beta.12 logged an update of only undefined members with null data.
		expect(
			canonicalizeLegacyOperation({ ...op, data: null, previousData: { assignee: 'bob' } }).data,
		).toEqual({ assignee: null })
	})

	test('no-op for version 2, envelopes, inserts and complete updates (same reference)', () => {
		const v2 = {
			type: 'update' as const,
			data: {},
			previousData: { a: 1 },
			hashVersion: 2 as const,
		}
		expect(canonicalizeLegacyOperation(v2)).toBe(v2)
		const insert = { type: 'insert' as const, data: { a: 1 }, previousData: null }
		expect(canonicalizeLegacyOperation(insert)).toBe(insert)
		const complete = { type: 'update' as const, data: { a: 2 }, previousData: { a: 1 } }
		expect(canonicalizeLegacyOperation(complete)).toBe(complete)
	})
})

describe('validateRecord produces the canonical values an operation carries', () => {
	const schema = defineSchema({
		version: 1,
		collections: {
			notes: {
				fields: {
					title: t.string(),
					meta: t.object({ a: t.number().optional(), b: t.string().optional() }).optional(),
					extra: t.json().optional(),
				},
			},
		},
	})
	const def = schema.collections.notes
	if (def === undefined) throw new Error('missing collection')

	test('undefined members dropped, Date converted, on insert and update', () => {
		const inserted = validateRecord(
			'notes',
			def,
			{ title: 'x', meta: { a: 1, b: undefined }, extra: { when: new Date(5) } },
			'insert',
		)
		expect(inserted).toEqual({
			title: 'x',
			meta: { a: 1 },
			extra: { when: '1970-01-01T00:00:00.005Z' },
		})
		const updated = validateRecord('notes', def, { meta: { a: 2, b: undefined } }, 'update')
		expect('b' in (updated.meta as Record<string, unknown>)).toBe(false)
	})

	test('a Map or Set in a json or object value is refused at validation, naming the field', () => {
		expect(() =>
			validateRecord('notes', def, { title: 'x', extra: { m: new Map() } }, 'insert'),
		).toThrow(/Field "extra" in collection "notes".*Object\.fromEntries/)
		expect(() => validateRecord('notes', def, { meta: { c: new Set([1]) } }, 'update')).toThrow(
			/Field "meta".*\[\.\.\.set\]/,
		)
	})
})

/** Values a developer can write into json fields, including the awkward ones. */
const jsonish: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
	value: fc.oneof(
		{ depthSize: 'small' },
		fc.string(),
		fc.double({ noNaN: true, noDefaultInfinity: true }),
		fc.boolean(),
		fc.constant(null),
		fc.constant(undefined),
		fc.date({ noInvalidDate: true }),
		fc.array(tie('value'), { maxLength: 4 }),
		fc.dictionary(fc.string({ maxLength: 6 }), tie('value'), { maxKeys: 4 }),
	),
})).value

describe('property: the id is stable across a JSON round trip of the canonical body', () => {
	propTest.prop([
		fc.constantFrom('insert' as const, 'update' as const),
		fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }), jsonish, { maxKeys: 5 }),
	])('createOperation id == id of JSON(op) and of JSON(JSON(op))', async (type, data) => {
		const op = await createOperation(
			input({
				type,
				data,
				previousData:
					type === 'update' ? Object.fromEntries(Object.keys(data).map((k) => [k, 1])) : null,
			}),
			new HybridLogicalClock('device-a'),
		)
		const once = JSON.parse(JSON.stringify(op))
		expect(once.data).toEqual(op.data)
		expect(await verifyOperationId(once)).toBe(true)
		expect(await verifyOperationId(JSON.parse(JSON.stringify(once)))).toBe(true)
		expect(canonicalizeOperationBody(once)).toEqual(once)
	})
})

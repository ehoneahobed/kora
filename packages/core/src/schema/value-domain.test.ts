import { describe, expect, test } from 'vitest'
import { SchemaValidationError } from '../errors/errors'
import { canonicalValue } from '../operations/canonical-body'
import { defineSchema } from './define'
import { t } from './types'
import { validateRecord } from './validation'
import {
	MAX_VALUE_DEPTH,
	TIMESTAMP_MAX_MS,
	TIMESTAMP_MIN_MS,
	measureOperationBytes,
	operationValueViolation,
	timestampDomainViolation,
} from './value-domain'

const schema = defineSchema({
	version: 1,
	collections: {
		things: {
			fields: {
				when: t.timestamp().optional(),
				n: t.number().optional(),
				days: t.array(t.timestamp()).optional(),
				meta: t.object({ at: t.timestamp().optional() }).optional(),
				doc: t.json().optional(),
				kind: t.enum(['a', 'b']).optional(),
			},
		},
	},
})
const things = schema.collections.things as NonNullable<(typeof schema.collections)['things']>

function insert(data: Record<string, unknown>): Record<string, unknown> {
	return validateRecord('things', things, data, 'insert')
}

function nest(depth: number): unknown {
	let value: unknown = 1
	for (let i = 0; i < depth; i++) value = { x: value }
	return value
}

describe('value domain (RT-86, RT-87)', () => {
	test('t.timestamp(): whole milliseconds within the Date range; fractions refused, not rounded', () => {
		expect(insert({ when: 1_791_000_000_000 })).toEqual({ when: 1_791_000_000_000 })
		expect(insert({ when: TIMESTAMP_MIN_MS, n: 1 }).when).toBe(TIMESTAMP_MIN_MS)
		expect(insert({ when: TIMESTAMP_MAX_MS }).when).toBe(TIMESTAMP_MAX_MS)
		for (const bad of [1_791_000_000_000.5, 1e20, -1e20, TIMESTAMP_MAX_MS + 1, Number.NaN]) {
			expect(() => insert({ when: bad })).toThrow(SchemaValidationError)
		}
		expect(() => insert({ when: new Date() })).toThrow(/timestamp/)
		expect(timestampDomainViolation(0.5)).toMatch(/whole milliseconds/)
		expect(() => insert({ when: 0.5 })).toThrow(/Math.round/)
	})

	test('timestamps nested in arrays and objects follow the same domain', () => {
		expect(() => insert({ days: [1, 2.5] })).toThrow(/days\[1\]/)
		expect(() => insert({ meta: { at: 1e20 } })).toThrow(/meta\.at/)
		expect(insert({ days: [1, 2], meta: { at: 3 } })).toEqual({ days: [1, 2], meta: { at: 3 } })
	})

	test('t.number(): finite doubles; Infinity is refused with a clear error', () => {
		expect(insert({ n: 1e308 }).n).toBe(1e308)
		expect(insert({ n: 5e-324 }).n).toBe(5e-324)
		expect(Object.is(insert({ n: -0 }).n, 0)).toBe(true)
		expect(() => insert({ n: Number.POSITIVE_INFINITY })).toThrow(/finite number/)
	})

	test('structured values: depth bound and no __proto__ key (refused, never dropped)', () => {
		expect(() => insert({ doc: nest(MAX_VALUE_DEPTH + 1) })).toThrow(/deeper than/)
		expect(insert({ doc: nest(MAX_VALUE_DEPTH - 1) }).doc).toEqual(nest(MAX_VALUE_DEPTH - 1))
		// The wire's binary form is reserved; integer keys and other members are plain data.
		expect(() => insert({ doc: { __kora_bytes__: 'AAEC' } })).toThrow(/__kora_bytes__/)
		expect(insert({ doc: { __kora_bytes__: 'AAEC', other: 1 } }).doc).toEqual({
			__kora_bytes__: 'AAEC',
			other: 1,
		})
		expect(insert({ doc: { '1': 2 } }).doc).toEqual({ '1': 2 })
		const parsed = JSON.parse('{"a":{"__proto__":{"x":1}}}')
		expect(() => insert({ doc: parsed })).toThrow(/__proto__/)
		expect(() => canonicalValue(parsed, 'doc')).toThrow(/__proto__/)
	})

	test('operationValueViolation: the server-side check of an operation value (op-data form)', () => {
		const fields = things.fields
		expect(operationValueViolation(fields.when as never, 1.5)).toMatch(/whole/)
		expect(operationValueViolation(fields.when as never, null)).toBeNull()
		expect(operationValueViolation(fields.kind as never, 'c')).toMatch(/one of/)
		expect(operationValueViolation(fields.days as never, [1, '2'])).toMatch(/\[1\]/)
		expect(operationValueViolation(fields.doc as never, JSON.parse('{"__proto__":1}'))).toMatch(
			/__proto__/,
		)
		expect(operationValueViolation(fields.n as never, 3)).toBeNull()
	})

	test('measureOperationBytes is the UTF-8 length of the JSON', () => {
		const op = { id: 'é', data: { s: '😀\u0000' } } as never
		expect(measureOperationBytes(op)).toBe(Buffer.byteLength(JSON.stringify(op), 'utf8'))
	})
})

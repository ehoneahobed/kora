import { describe, expect, test } from 'vitest'
import { defineSchema } from '../schema/define'
import { t } from '../schema/types'
import type { Operation, SchemaDefinition } from '../types'
import { foldRecord, materialize } from './fold'
import { deserializeFoldState, serializeFoldState } from './serialize'

/**
 * Round-4 P3s: a custom resolver's output is canonicalized like any written value, so
 * the in-memory and persisted fold states agree; an own `__proto__` key already in a
 * stored value is kept by the fold rather than turned into a prototype.
 */
function schemaWith(resolve: (local: unknown, remote: unknown, base: unknown) => unknown) {
	return defineSchema({
		version: 1,
		collections: {
			items: {
				fields: { v: t.json().optional(), doc: t.json().optional() },
				resolve: { v: resolve },
			},
		},
	}) as unknown as SchemaDefinition
}

let n = 0
function write(type: Operation['type'], data: Record<string, unknown>, wall: number): Operation {
	n += 1
	return {
		id: `op-${n}`,
		nodeId: 'a',
		type,
		collection: 'items',
		recordId: 'r',
		data,
		previousData: type === 'update' ? { v: 1 } : null,
		timestamp: { wallTime: wall, logical: 0, nodeId: 'a' },
		sequenceNumber: n,
		causalDeps: [],
		schemaVersion: 1,
	}
}

function persistedRoundTrip(schema: SchemaDefinition, ops: Operation[]) {
	const state = foldRecord(ops, schema).state
	if (state === null) throw new Error('no state')
	const reloaded = deserializeFoldState(serializeFoldState(state))
	return { live: materialize(state), reloaded: materialize(reloaded), state }
}

describe('custom resolver outputs are canonical', () => {
	for (const [label, output, expected] of [
		['-0', -0, 0],
		['a Date', new Date(1_791_000_000_000), new Date(1_791_000_000_000).toISOString()],
		['undefined', undefined, null],
		['an object with an undefined member', { a: 1, b: undefined }, { a: 1 }],
	] as const) {
		test(`${label}: the live and persisted states agree`, () => {
			const schema = schemaWith(() => output)
			const { live, reloaded } = persistedRoundTrip(schema, [
				write('insert', { v: 1 }, 1000),
				write('update', { v: 2 }, 2000),
			])
			expect(live?.v).toEqual(expected)
			expect(Object.is(live?.v, -0)).toBe(false)
			expect(reloaded).toEqual(live)
		})
	}

	test('an output with no JSON form falls back like a throwing resolver, and says so', () => {
		const schema = schemaWith(() => Number.NaN)
		const { live, state } = persistedRoundTrip(schema, [
			write('insert', { v: 1 }, 1000),
			write('update', { v: 2 }, 2000),
		])
		expect(live?.v).toBe(2)
		const field = state.f.v as { err?: string }
		expect(field.err).toMatch(/NaN/)
	})
})

describe('an own __proto__ key', () => {
	test('is refused for every new write; a legacy stored one is dropped alike on every replica', () => {
		const value = JSON.parse('{"__proto__":{"x":1},"y":2}') as Record<string, unknown>
		// New writes: refused at validation and canonicalization (value-domain.test.ts).
		// A value stored before that rule folds the same everywhere, without the key, and
		// never throws.
		const schema = schemaWith((_l, remote) => remote)
		const { live, reloaded } = persistedRoundTrip(schema, [write('insert', { doc: value }, 1000)])
		expect(live?.doc).toEqual({ y: 2 })
		expect(reloaded).toEqual(live)
	})
})

import { describe, expect, test } from 'vitest'
import { defineSchema } from '../schema/define'
import { t } from '../schema/types'
import type { Operation, SchemaDefinition } from '../types'
import { foldRecord, materialize } from './fold'
import { deserializeFoldState, serializeFoldState } from './serialize'

/**
 * A json or object value may use any string as a key, including the names of
 * Object.prototype members. The fold keeps keys in plain objects, so a key named
 * `toString` once made an insert throw ("Cannot read properties of undefined") and the
 * key `__proto__` (refused earlier, by value validation) would have set a prototype.
 */
const schema = defineSchema({
	version: 1,
	collections: { items: { fields: { meta: t.json().optional() } } },
}) as unknown as SchemaDefinition

let counter = 0
function op(
	type: Operation['type'],
	data: Record<string, unknown>,
	previousData: Record<string, unknown> | null,
	wall: number,
): Operation {
	counter += 1
	return {
		id: `op-${counter}`,
		nodeId: 'a',
		type,
		collection: 'items',
		recordId: 'r',
		data,
		previousData,
		timestamp: { wallTime: wall, logical: 0, nodeId: 'a' },
		sequenceNumber: counter,
		causalDeps: [],
		schemaVersion: 1,
	}
}

function parse(json: string): Record<string, unknown> {
	return JSON.parse(json) as Record<string, unknown>
}

describe('json keys named like Object.prototype members', () => {
	// `__proto__` itself is refused earlier, by value validation.
	for (const key of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) {
		test(`the key ${key} folds, updates, merges and survives a persisted round trip`, () => {
			const first = parse(`{"${key}": 1, "plain": 2}`)
			const second = parse(`{"${key}": 3, "plain": 2}`)
			const ops = [
				op('insert', { meta: first }, null, 1),
				op('update', { meta: second }, { meta: first }, 2),
			]
			const folded = foldRecord(ops, schema).state
			if (folded === null) throw new Error('no state')
			const live = materialize(folded) as { meta: Record<string, unknown> }
			expect(Object.keys(live.meta).sort()).toEqual([key, 'plain'].sort())
			expect(Object.getOwnPropertyDescriptor(live.meta, key)?.value).toBe(3)
			expect(Object.getPrototypeOf(live.meta)).toBe(Object.prototype)

			// Order does not matter: the same set of operations, reversed.
			const reversed = foldRecord([...ops].reverse(), schema).state
			expect(reversed && materialize(reversed)).toEqual(live)

			const reloaded = materialize(deserializeFoldState(serializeFoldState(folded)))
			expect(reloaded).toEqual(live)
		})
	}

	test('removing a key named toString deletes it', () => {
		const first = parse('{"toString": 1, "plain": 2}')
		const ops = [
			op('insert', { meta: first }, null, 1),
			op('update', { meta: { plain: 2 } }, { meta: first }, 2),
		]
		const folded = foldRecord(ops, schema).state
		if (folded === null) throw new Error('no state')
		const live = materialize(folded) as { meta: Record<string, unknown> }
		expect(Object.keys(live.meta)).toEqual(['plain'])
	})
})

import { fc, test as propTest } from '@fast-check/vitest'
import { HybridLogicalClock } from '@korajs/core'
import type { HLCTimestamp } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import {
	type FieldVersions,
	parseFieldVersions,
	resolvePerFieldLww,
	serializeFieldVersions,
} from './field-versions'
import { serializeRowVersion } from './row-version'

/**
 * A single concurrent write in the property model: which field it touches, the
 * value it carries, and the HLC timestamp that stamps it.
 */
interface FieldWrite {
	field: string
	value: string
	timestamp: HLCTimestamp
}

const FIELDS = ['title', 'assignee', 'status', 'notes'] as const

const timestampArb = fc.record({
	wallTime: fc.integer({ min: 1, max: 1_000_000 }),
	logical: fc.integer({ min: 0, max: 50 }),
	nodeId: fc.constantFrom('node-a', 'node-b', 'node-c', 'node-d'),
})

const writeArb: fc.Arbitrary<FieldWrite> = fc.record({
	field: fc.constantFrom(...FIELDS),
	value: fc.string({ minLength: 1, maxLength: 6 }),
	timestamp: timestampArb,
})

/**
 * Fold a sequence of writes through the per-field LWW register in the given
 * order, returning the final field->value and field->version maps. This is the
 * pure model of what `store.applyRemoteOperation` does field-by-field.
 */
function foldWrites(writes: FieldWrite[]): {
	values: Record<string, string>
	versions: FieldVersions
} {
	let versions: FieldVersions = {}
	const values: Record<string, string> = {}
	for (const write of writes) {
		const incomingVersion = serializeRowVersion(write.timestamp)
		const { winners, merged } = resolvePerFieldLww(
			versions,
			[write.field],
			incomingVersion,
			undefined,
		)
		versions = merged
		if (winners.includes(write.field)) {
			values[write.field] = write.value
		}
	}
	return { values, versions }
}

/** Deterministic shuffle driven by a permutation index array from fast-check. */
function applyPermutation<T>(items: T[], order: number[]): T[] {
	return order.map((i) => items[i]).filter((x): x is T => x !== undefined)
}

describe('per-field LWW register', () => {
	test('parse/serialize round-trips and tolerates junk', () => {
		expect(parseFieldVersions('{}')).toEqual({})
		expect(parseFieldVersions('')).toEqual({})
		expect(parseFieldVersions(null)).toEqual({})
		expect(parseFieldVersions('not json')).toEqual({})
		expect(parseFieldVersions('[1,2,3]')).toEqual({})
		const map = { title: '000000000000100:00000:node-a' }
		expect(parseFieldVersions(serializeFieldVersions(map))).toEqual(map)
	})

	test('the max-timestamp writer wins a same-field contest', () => {
		const early: HLCTimestamp = { wallTime: 100, logical: 0, nodeId: 'node-a' }
		const late: HLCTimestamp = { wallTime: 200, logical: 0, nodeId: 'node-b' }
		const result = foldWrites([
			{ field: 'title', value: 'early', timestamp: early },
			{ field: 'title', value: 'late', timestamp: late },
		])
		expect(result.values.title).toBe('late')
	})

	// CLAUDE.md: merge must be DETERMINISTIC and ORDER-INDEPENDENT. Folding the
	// same writes in any order must yield identical materialized state — this is
	// the exact guarantee the concurrent-multifield sync bug violated.
	propTest.prop([fc.array(writeArb, { minLength: 1, maxLength: 12 })])(
		'folding writes is order-independent (convergence)',
		(writes) => {
			const canonical = foldWrites(writes)
			// Try several independent shuffles; all must converge to the same state.
			const orders = [
				[...writes].reverse(),
				[...writes].sort((a, b) => a.field.localeCompare(b.field)),
				[...writes].sort((a, b) => HybridLogicalClock.compare(a.timestamp, b.timestamp)),
				[...writes].sort((a, b) => HybridLogicalClock.compare(b.timestamp, a.timestamp)),
			]
			for (const order of orders) {
				const folded = foldWrites(order)
				expect(folded.values).toEqual(canonical.values)
			}
		},
	)

	// A true random permutation (not just a fixed set of sorts) must also
	// converge — this is the general order-independence property.
	propTest.prop([
		fc.array(writeArb, { minLength: 1, maxLength: 12 }).chain((writes) =>
			fc.tuple(
				fc.constant(writes),
				fc.shuffledSubarray(
					writes.map((_, i) => i),
					{ minLength: writes.length, maxLength: writes.length },
				),
			),
		),
	])('any random permutation converges to the same values', ([writes, order]) => {
		const canonical = foldWrites(writes)
		const permuted = foldWrites(applyPermutation(writes, order))
		expect(permuted.values).toEqual(canonical.values)
	})

	// Idempotency: re-applying a write that already lost (or already won) never
	// changes the outcome. Content-addressing dedups at the op layer, but the
	// register must be idempotent on its own.
	propTest.prop([fc.array(writeArb, { minLength: 1, maxLength: 10 })])(
		're-applying the whole sequence is idempotent',
		(writes) => {
			const once = foldWrites(writes)
			const twice = foldWrites([...writes, ...writes])
			expect(twice.values).toEqual(once.values)
		},
	)
})

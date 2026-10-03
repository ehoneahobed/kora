/**
 * RT-79 repro (Phase 3 red team round 3, 2026-10-03): a `Date` inside a `t.json()` (or
 * object) value is hashed as `{}` but stored and uploaded as its ISO string, so the
 * server refuses the insert `INVALID_OPERATION_ID` (terminal) and the record vanishes
 * from the writing device.
 *
 * The RT-72 fix states one rule, "the hashed content is exactly the JSON content".
 * It holds for `undefined` members only:
 * - `validateRecord` accepts a `Date` in a json value (the JSON-serializable check
 *   refuses functions, NaN, undefined, but not objects with `toJSON`);
 * - `stripUndefinedMembers` leaves non-plain objects as they are;
 * - the version-2 canonical form (`canonicalBinary` in core content-hash.ts) walks
 *   `Object.entries(date)`, which is empty: the id covers `{"when":{}}`;
 * - the op log and the wire are `JSON.stringify` output: `{"when":"1970-01-01T..."}`.
 * The server recomputes the hash over what it received and refuses the op; the device
 * excludes the refused insert from its fold. Not a round-2 regression (same at 07e4f45).
 *
 * Asserts the CORRECT behaviour (fails at 97981a7): the insert is accepted and synced
 * (or refused up front by validation, with the record never created).
 */
import { defineSchema, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { type TestDevice, createTestNetwork } from '../../src/index'

const schema = defineSchema({
	version: 1,
	collections: {
		notes: { fields: { title: t.string(), extra: t.json().optional() } },
	},
}) as unknown as SchemaDefinition

describe('RT-79: a Date in a json value breaks the content hash', () => {
	test('an insert with { when: new Date() } in a json field is accepted and synced', async () => {
		const network = await createTestNetwork(schema, { devices: 2 })
		try {
			const [a, b] = network.devices as [TestDevice, TestDevice]
			let threw = false
			try {
				await a.collection('notes').insert({ title: 'x', extra: { when: new Date(5) } })
			} catch {
				// Refusing a Date up front (validation) would also be correct.
				threw = true
			}
			for (let i = 0; i < 3; i++) {
				await a.sync()
				await b.sync()
			}
			expect((await a.getRejectedOperations()).map((r) => r.code)).toEqual([])
			const expected = threw ? 0 : 1
			expect(await a.getState('notes')).toHaveLength(expected)
			expect(await b.getState('notes')).toHaveLength(expected)
		} finally {
			await network.close()
		}
	}, 60_000)
})

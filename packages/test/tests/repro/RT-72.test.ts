/**
 * RT-72 repro (Phase 3 red team round 2, 2026-10-03): a protocol-2 device's insert whose
 * object field holds an `undefined` member is refused by the server and the record
 * vanishes from the writing device.
 *
 * `validateRecord` accepts `t.object(...)` values with `undefined` members (declared
 * nested keys are only type-checked when present). `createOperation` hashes the data
 * with `canonicalize`, which writes `"b":null` for such a member; the op log and the
 * wire are JSON, so the uploaded data has no `b`. The server recomputes the version-2
 * hash over what it received, the id does not match, and the insert is refused
 * INVALID_OPERATION_ID (terminal). The device then excludes it from its fold: the
 * user's record disappears. A form that builds `{ a, b: input || undefined }` is enough.
 *
 * Asserts the CORRECT behaviour (fails at 4d6c8a7): the insert is accepted and reaches
 * the peer.
 */
import { defineSchema, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { type TestDevice, createTestNetwork } from '../../src/index'

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
}) as unknown as SchemaDefinition

describe('RT-72: undefined object members break the content hash', () => {
	test('an insert with { a: 1, b: undefined } is accepted and synced', async () => {
		const network = await createTestNetwork(schema, { devices: 2 })
		try {
			const [a, b] = network.devices as [TestDevice, TestDevice]
			await a.collection('notes').insert({ title: 'x', meta: { a: 1, b: undefined } })
			for (let i = 0; i < 3; i++) {
				await a.sync()
				await b.sync()
			}
			expect((await a.getRejectedOperations()).map((r) => r.code)).toEqual([])
			expect(await a.getState('notes')).toHaveLength(1)
			expect(await b.getState('notes')).toHaveLength(1)
		} finally {
			await network.close()
		}
	}, 60_000)
})

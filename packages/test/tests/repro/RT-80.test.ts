/**
 * RT-80 repro (Phase 3 red team round 3, 2026-10-03): `update(id, { field: undefined })`
 * on a beta.14 device produces an operation that its own server refuses
 * `INVALID_OPERATION_ID` (terminal), reported as "altered after it was created".
 *
 * `createOperation` strips `undefined` members (RT-72), so the update's data is `{}`
 * and the version-2 id covers `"data":{}`. The store's op log reads an empty data
 * object back as `null` (`deserializeOperation`: `Object.keys(rest).length > 0 ? rest :
 * null`), and that is what is uploaded. The server's hash over `null` differs. The field
 * is not cleared anywhere (beta.13 cleared it, and the server now stores a beta.13
 * client's same call as a clear, RT-71), and the developer gets a terminal integrity
 * rejection for a no-op. Not a round-2 regression (same at 07e4f45); the round-2
 * register said top-level `undefined` in an update passes.
 *
 * Asserts the CORRECT behaviour (fails at 97981a7): no rejection, and the writer and its
 * peer agree.
 */
import { defineSchema, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { type TestDevice, createTestNetwork } from '../../src/index'

const schema = defineSchema({
	version: 1,
	collections: {
		notes: { fields: { title: t.string(), assignee: t.string().optional() } },
	},
}) as unknown as SchemaDefinition

describe('RT-80: an update of only undefined fields is refused as tampered', () => {
	test('update(id, { assignee: undefined }) is not refused INVALID_OPERATION_ID', async () => {
		const network = await createTestNetwork(schema, { devices: 2 })
		try {
			const [a, b] = network.devices as [TestDevice, TestDevice]
			const row = await a.collection('notes').insert({ title: 'x', assignee: 'bob' })
			await a.collection('notes').update(String(row.id), { assignee: undefined })
			for (let i = 0; i < 3; i++) {
				await a.sync()
				await b.sync()
			}
			expect((await a.getRejectedOperations()).map((r) => r.code)).toEqual([])
			const view = async (d: TestDevice) =>
				(await d.getState('notes')).map((r) => [r.title, r.assignee ?? null])
			expect(await view(a)).toEqual(await view(b))
		} finally {
			await network.close()
		}
	}, 60_000)
})

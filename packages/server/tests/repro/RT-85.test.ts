/**
 * RT-85 repro (Phase 3 red team round 4, 2026-10-03): a server schema transform that
 * drops a field from an update's `data` now CLEARS that field on the server and on every
 * peer.
 *
 * `transformForServerSchema` strips `hashVersion` from every transformed operation, so the
 * stored copy is a "version-1" operation. Round 4 applies `canonicalizeLegacyOperation`
 * in `mergeOp` to every operation without `hashVersion: 2`: a `previousData` key absent
 * from `data` is a clear (`null`). An operation transform rewrites `data` (the documented
 * `OperationTransform` contract says nothing about `previousData`), so a transform that
 * stops older clients from writing a field (`delete data.score`) leaves `score` in
 * `previousData`, and every fold turns the stripped write into `score: null`.
 *
 * Before round 4 the stored copy simply did not touch `score`.
 *
 * Asserts the CORRECT behaviour (fails at 5498764): the field the transform dropped keeps
 * its value.
 */
import { HybridLogicalClock, createOperation, defineSchema, t } from '@korajs/core'
import type { Operation, OperationTransform } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { createHarness, sendAndAwaitAck } from './rt-fixture'

const schemaV2 = defineSchema({
	version: 2,
	collections: { notes: { fields: { title: t.string(), score: t.number().optional() } } },
})

// v2: `score` is computed by the server; writes to it from v1 clients are dropped.
const transforms: OperationTransform[] = [
	{
		fromVersion: 1,
		toVersion: 2,
		transform: (op) => {
			if (op.type !== 'update' || op.data === null) return { ...op, schemaVersion: 2 }
			const { score: _dropped, ...data } = op.data
			return { ...op, data, schemaVersion: 2 }
		},
	},
]

function op(
	nodeId: string,
	seq: number,
	fields: Pick<Operation, 'type' | 'data' | 'previousData' | 'schemaVersion'>,
	clock: HybridLogicalClock,
): Promise<Operation> {
	return createOperation(
		{
			nodeId,
			collection: 'notes',
			recordId: 'note-1',
			sequenceNumber: seq,
			causalDeps: [],
			...fields,
		},
		clock,
	)
}

describe('RT-85: a transform that drops a field from an update clears it everywhere', () => {
	test('v1 update { title, score }, transform drops score: score must keep its value', async () => {
		const { store, server, login } = await createHarness(schemaV2, null, {
			schemaVersion: 2,
			supportedSchemaVersions: { min: 1, max: 2 },
			operationTransforms: transforms,
		})
		const v2 = await login('t', 'dev-v2', { protocolVersion: 2, sequenceReservation: true })
		const insert = await op(
			'dev-v2',
			1,
			{ type: 'insert', data: { title: 'a', score: 5 }, previousData: null, schemaVersion: 2 },
			new HybridLogicalClock('dev-v2'),
		)
		await sendAndAwaitAck(v2, [insert])
		expect(await store.findRecord('notes', 'note-1')).toMatchObject({ title: 'a', score: 5 })

		const v1 = await login('t', 'dev-v1', {
			protocolVersion: 2,
			sequenceReservation: true,
			schemaVersion: 1,
		})
		const update = await op(
			'dev-v1',
			1,
			{
				type: 'update',
				data: { title: 'b', score: 9 },
				previousData: { title: 'a', score: 5 },
				schemaVersion: 1,
			},
			new HybridLogicalClock('dev-v1'),
		)
		await sendAndAwaitAck(v1, [update])
		const row = await store.findRecord('notes', 'note-1')
		expect(row?.title).toBe('b')
		// Fails: score is null (the transformed copy is folded as a beta.12 clear).
		expect(row?.score).toBe(5)
		await server.stop()
	})
})

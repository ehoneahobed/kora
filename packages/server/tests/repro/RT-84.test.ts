/**
 * RT-84 repro (Phase 3 red team round 4, 2026-10-03): an honest re-upload of an operation
 * the server stored through a schema transform is refused FORGED_DUPLICATE (terminal).
 *
 * `transformForServerSchema` stores a transformed operation under the ORIGINAL id with
 * the transformed data and schema version, and strips its `hashVersion` (the stored copy
 * is "version 1, unverified"). The RT-77 duplicate check (`isSameStoredOperation`) then
 * compares the upload against that stored copy:
 * - an upload declaring `hashVersion: 2` (every protocol-2 writer) never equals a stored
 *   copy without one (`upload.hashVersion !== storedVersion`);
 * - an upload without a declared version differs in `data` (the transform rewrote it).
 * Either way the device's own, unaltered operation is refused as tampering, non-retriably.
 *
 * A device re-uploads its own operations whenever an acknowledgment was lost (the batch
 * was stored, the connection dropped before the ack), and after a server restore
 * ("server-behind"): the server's vector is never trusted as an acknowledgment (RT-12).
 * The device then excludes its refused write from its fold, while the server and every
 * peer keep it: a permanent divergence (the device holds the id, so the server's copy
 * is never applied).
 *
 * Asserts the CORRECT behaviour (fails at 5498764): the re-upload is acknowledged as a
 * duplicate, with no rejection.
 */
import { HybridLogicalClock, createOperation, defineSchema, t } from '@korajs/core'
import type { Operation, OperationTransform } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { createHarness, sendAndAwaitAck } from './rt-fixture'

const schemaV2 = defineSchema({
	version: 2,
	collections: { notes: { fields: { title: t.string(), tag: t.string().optional() } } },
})

const transforms: OperationTransform[] = [
	{
		fromVersion: 1,
		toVersion: 2,
		transform: (op) =>
			op.type === 'insert'
				? { ...op, data: { ...op.data, tag: 'migrated' }, schemaVersion: 2 }
				: { ...op, schemaVersion: 2 },
	},
]

async function v1Insert(nodeId: string, hashVersion: 1 | 2): Promise<Operation> {
	return createOperation(
		{
			nodeId,
			type: 'insert',
			collection: 'notes',
			recordId: `rec-${nodeId}`,
			data: { title: 'written on schema v1' },
			previousData: null,
			sequenceNumber: 1,
			causalDeps: [],
			schemaVersion: 1,
		},
		new HybridLogicalClock(nodeId),
		{ hashVersion },
	)
}

function rejectionCodes(messages: Array<{ type: string }>): string[] {
	return messages.flatMap((m) =>
		m.type === 'operation-rejected' ? [(m as unknown as { code: string }).code] : [],
	)
}

describe('RT-84: an honest re-upload of a server-transformed operation is refused as forged', () => {
	for (const [label, hashVersion, protocolVersion] of [
		['protocol-2 writer (hash version 2)', 2, 2],
		['beta.13 writer (hash version 1, protocol 1)', 1, undefined],
	] as const) {
		test(`${label}: a lost ack, then the same op again`, async () => {
			const { server, login } = await createHarness(schemaV2, null, {
				schemaVersion: 2,
				supportedSchemaVersions: { min: 1, max: 2 },
				operationTransforms: transforms,
			})
			const op = await v1Insert(`dev-${hashVersion}`, hashVersion)
			const handshake = {
				schemaVersion: 1,
				...(protocolVersion ? { protocolVersion, sequenceReservation: true } : {}),
			}
			const first = await login('t', op.nodeId, handshake)
			await sendAndAwaitAck(first, [op])
			expect(rejectionCodes(first.messages)).toEqual([])

			// The ack never reached the device; it reconnects and re-sends the same op.
			const second = await login('t', op.nodeId, handshake)
			await sendAndAwaitAck(second, [op])
			// Fails: FORGED_DUPLICATE (non-retriable) for the device's own unaltered write.
			expect(rejectionCodes(second.messages)).toEqual([])
			await server.stop()
		})
	}
})

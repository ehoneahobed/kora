import { describe, expect, test } from 'vitest'
import { HybridLogicalClock } from '../../src/clock/hlc'
import { createOperation, verifyOperationIntegrity } from '../../src/operations/operation'
import type { Operation } from '../../src/types'

/**
 * CORE-1: the content-addressed id must commit to every field that influences
 * merge / sync semantics. Today computeOperationId hashes only
 * type, collection, recordId, data, timestamp, nodeId (+atomicOps), so
 * previousData (merge base, server scope check), sequenceNumber (version
 * vectors), causalDeps (topological order) and schemaVersion (transforms)
 * can be rewritten without changing the id.
 */
async function baseOp(): Promise<Operation> {
	const clock = new HybridLogicalClock('node-a')
	return createOperation(
		{
			nodeId: 'node-a',
			type: 'update',
			collection: 'tickets',
			recordId: 'r1',
			data: { tags: [] },
			previousData: { tags: ['urgent'] },
			sequenceNumber: 2,
			causalDeps: ['dep-1'],
			schemaVersion: 1,
		},
		clock,
	)
}

describe('CORE-1 op id must cover all semantic fields', () => {
	const tampers: Array<[string, (op: Operation) => Operation]> = [
		[
			'previousData',
			(op) => ({ ...op, previousData: { tags: ['urgent', 'vip'], ownerId: 'mallory' } }),
		],
		['sequenceNumber', (op) => ({ ...op, sequenceNumber: 1_000_000_000 })],
		['causalDeps', (op) => ({ ...op, causalDeps: [] })],
		['schemaVersion', (op) => ({ ...op, schemaVersion: 99 })],
	]
	for (const [field, tamper] of tampers) {
		test(`tampering ${field} is detected by verifyOperationIntegrity`, async () => {
			const op = await baseOp()
			expect(await verifyOperationIntegrity(op)).toBe(true)
			expect(await verifyOperationIntegrity(tamper(op))).toBe(false)
		})
	}
})

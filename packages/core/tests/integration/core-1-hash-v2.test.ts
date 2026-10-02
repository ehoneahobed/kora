import { describe, expect, test } from 'vitest'
import { HybridLogicalClock } from '../../src/clock/hlc'
import { createOperation, verifyOperationId } from '../../src/operations/operation'
import type { Operation } from '../../src/types'

/**
 * CORE-1 acceptance (Stage A, pure core): the same tampers as
 * tests/repro/CORE-1.test.ts, against an operation created with content hash
 * version 2. The repro itself stays red until protocol v2 makes version 2 the
 * default for new operations (Stage B).
 */
async function baseOp(): Promise<Operation> {
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
		new HybridLogicalClock('node-a'),
		{ hashVersion: 2 },
	)
}

describe('CORE-1 (hash v2): op id covers all semantic fields', () => {
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
		test(`tampering ${field} is detected by verifyOperationId`, async () => {
			const op = await baseOp()
			expect(await verifyOperationId(op)).toBe(true)
			expect(await verifyOperationId(tamper(op))).toBe(false)
		})
	}
})

import { HybridLogicalClock, createOperation } from '@korajs/core'
import type { Operation } from '@korajs/core'
import type { SideEffectOp } from '@korajs/merge'
import type { ServerStore } from '../store/server-store'

/**
 * Converts a merge-package referential side effect into a server-originated operation.
 */
export async function createServerSideEffectOperation(
	store: ServerStore,
	parentOp: Operation,
	effect: SideEffectOp,
	schemaVersion: number,
	sequenceNumber: number,
): Promise<Operation> {
	const nodeId = store.getNodeId()
	const clock = new HybridLogicalClock(nodeId)
	clock.receive(parentOp.timestamp)

	return createOperation(
		{
			nodeId,
			type: effect.type === 'delete' ? 'delete' : 'update',
			collection: effect.collection,
			recordId: effect.recordId,
			data: effect.data,
			previousData: effect.previousData,
			sequenceNumber,
			causalDeps: [parentOp.id],
			schemaVersion,
		},
		clock,
	)
}

/**
 * Allocate the next sequence number for server-originated operations.
 */
export function nextServerSequenceNumber(store: ServerStore): number {
	const nodeId = store.getNodeId()
	const current = store.getVersionVector().get(nodeId) ?? 0
	return current + 1
}

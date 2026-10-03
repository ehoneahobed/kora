import { createHash } from 'node:crypto'
import { HybridLogicalClock } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { canonicalize } from '@korajs/core/internal'

/**
 * The version-1 content hash of an operation, computed synchronously (node:crypto) so
 * synchronous test helpers can give hand-built operations real ids. The server verifies
 * every uploaded plaintext id, version 1 included (RT-64): an operation whose id was
 * not computed from its content is refused with INVALID_OPERATION_ID.
 */
export function contentIdV1(op: Omit<Operation, 'id'>): string {
	const input: Record<string, unknown> = {
		type: op.type,
		collection: op.collection,
		recordId: op.recordId,
		data: op.data,
		timestamp: HybridLogicalClock.serialize(op.timestamp),
		nodeId: op.nodeId,
	}
	if (op.atomicOps !== undefined && Object.keys(op.atomicOps).length > 0) {
		input.atomicOps = op.atomicOps
	}
	return createHash('sha256').update(canonicalize(input)).digest('hex')
}

/** The operation with its id replaced by its version-1 content hash. */
export function withContentId<T extends Operation>(op: T): T {
	const { id: _ignored, ...rest } = op
	return { ...op, id: contentIdV1(rest) }
}

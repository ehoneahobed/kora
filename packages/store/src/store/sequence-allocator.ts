import type { StorageAdapter, Transaction } from '../types'

interface SequenceRow {
	sequence_number: number
}

/**
 * Atomically increment and return the next sequence number for a node.
 * Uses SQLite UPSERT + RETURNING so concurrent tabs do not reuse sequence slots.
 */
export async function allocateNextSequenceNumber(
	adapter: StorageAdapter,
	nodeId: string,
): Promise<number> {
	const rows = await adapter.query<SequenceRow>(
		`INSERT INTO _kora_version_vector (node_id, sequence_number) VALUES (?, 1)
     ON CONFLICT(node_id) DO UPDATE SET sequence_number = sequence_number + 1
     RETURNING sequence_number`,
		[nodeId],
	)
	const seq = rows[0]?.sequence_number
	if (seq === undefined) {
		throw new Error(`Failed to allocate sequence number for node "${nodeId}"`)
	}
	return seq
}

/**
 * Allocate the next sequence inside an existing storage transaction.
 */
export async function allocateNextSequenceInTransaction(
	tx: Transaction,
	nodeId: string,
): Promise<number> {
	const rows = await tx.query<SequenceRow>(
		`INSERT INTO _kora_version_vector (node_id, sequence_number) VALUES (?, 1)
     ON CONFLICT(node_id) DO UPDATE SET sequence_number = sequence_number + 1
     RETURNING sequence_number`,
		[nodeId],
	)
	const seq = rows[0]?.sequence_number
	if (seq === undefined) {
		throw new Error(`Failed to allocate sequence number for node "${nodeId}" in transaction`)
	}
	return seq
}

/**
 * Read the current sequence for a node without incrementing.
 */
export async function readSequenceNumber(adapter: StorageAdapter, nodeId: string): Promise<number> {
	const rows = await adapter.query<SequenceRow>(
		'SELECT sequence_number FROM _kora_version_vector WHERE node_id = ?',
		[nodeId],
	)
	return rows[0]?.sequence_number ?? 0
}

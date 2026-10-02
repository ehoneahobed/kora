import type { StorageAdapter, Transaction } from '../types'

interface SequenceRow {
	sequence_number: number
}

/**
 * Reserve the next sequence number for a node inside a write transaction
 * (UPSERT ... RETURNING on `_kora_version_vector`).
 *
 * This is the ONLY way a local operation gets its number: the reservation
 * commits or rolls back with the operation that uses it, and transactions are
 * serialized, so the numbers of one commit are contiguous and never shared. There
 * is deliberately no variant that allocates outside a transaction (W6).
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

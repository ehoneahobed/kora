import { bigint, index, integer, pgTable, text } from 'drizzle-orm/pg-core'

/**
 * Drizzle schema for the Kora sync server's PostgreSQL database.
 *
 * Two tables:
 * - `pgOperations` — the append-only operation log (content-addressed by id)
 * - `pgSyncState` — tracks the max sequence number seen per node (version vector)
 *
 * Column structure mirrors the SQLite drizzle-schema.ts but uses pgTable.
 */

export const pgOperations = pgTable(
	'operations',
	{
		id: text('id').primaryKey(),
		nodeId: text('node_id').notNull(),
		type: text('type').notNull(),
		collection: text('collection').notNull(),
		recordId: text('record_id').notNull(),
		data: text('data'), // JSON-serialized, null for deletes
		previousData: text('previous_data'), // JSON-serialized, null for insert/delete
		atomicOps: text('atomic_ops'), // JSON-serialized Record<field, AtomicOp>, null when none
		wallTime: bigint('wall_time', { mode: 'number' }).notNull(),
		logical: integer('logical').notNull(),
		timestampNodeId: text('timestamp_node_id').notNull(),
		sequenceNumber: integer('sequence_number').notNull(),
		causalDeps: text('causal_deps').notNull().default('[]'), // JSON array of op IDs
		schemaVersion: integer('schema_version').notNull(),
		receivedAt: bigint('received_at', { mode: 'number' }).notNull(),
		// Server-assigned monotonic delivery sequence, ordered by commit (assigned from
		// a counter row locked inside the append transaction, so delivery order equals
		// visibility order even across instances). Drives the gap-free server->client
		// delivery watermark. Nullable only for pre-column rows, backfilled on startup.
		deliverySeq: bigint('delivery_seq', { mode: 'number' }),
	},
	(table) => ({
		nodeSeqIdx: index('idx_pg_node_seq').on(table.nodeId, table.sequenceNumber),
		collectionIdx: index('idx_pg_collection').on(table.collection),
		receivedIdx: index('idx_pg_received').on(table.receivedAt),
		deliveryIdx: index('idx_pg_delivery_seq').on(table.deliverySeq),
	}),
)

export const pgSyncState = pgTable('sync_state', {
	nodeId: text('node_id').primaryKey(),
	maxSequenceNumber: integer('max_sequence_number').notNull(),
	lastSeenAt: bigint('last_seen_at', { mode: 'number' }).notNull(),
})

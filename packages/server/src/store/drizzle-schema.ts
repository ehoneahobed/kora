import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * Drizzle schema for the Kora sync server's SQLite database.
 *
 * Two tables:
 * - `operations` — the append-only operation log (content-addressed by id)
 * - `syncState` — tracks the max sequence number seen per node (version vector)
 */

export const operations = sqliteTable(
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
		wallTime: integer('wall_time').notNull(),
		logical: integer('logical').notNull(),
		timestampNodeId: text('timestamp_node_id').notNull(),
		sequenceNumber: integer('sequence_number').notNull(),
		causalDeps: text('causal_deps').notNull().default('[]'), // JSON array of op IDs
		schemaVersion: integer('schema_version').notNull(),
		receivedAt: integer('received_at').notNull(),
		// Server-assigned monotonic delivery sequence, ordered by commit. Drives the
		// gap-free server->client delivery watermark. Nullable only for rows written
		// before the column existed; those are backfilled on startup.
		deliverySeq: integer('delivery_seq'),
	},
	(table) => ({
		nodeSeqIdx: index('idx_node_seq').on(table.nodeId, table.sequenceNumber),
		collectionIdx: index('idx_collection').on(table.collection),
		receivedIdx: index('idx_received').on(table.receivedAt),
		deliveryIdx: index('idx_delivery_seq').on(table.deliverySeq),
	}),
)

export const syncState = sqliteTable('sync_state', {
	nodeId: text('node_id').primaryKey(),
	maxSequenceNumber: integer('max_sequence_number').notNull(),
	lastSeenAt: integer('last_seen_at').notNull(),
})

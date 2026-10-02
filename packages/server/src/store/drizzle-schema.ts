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
		// JSON { pre, post }: the record's scope values around this operation, captured
		// from the server's own rows at apply time (RT-14). Null for legacy rows that
		// could not be backfilled.
		scopeSnapshot: text('scope_snapshot'),
		// 1 when this row was the sole holder of its (node_id, sequence_number) when stored;
		// 0 for the second operation of a legacy duplicate pair and for rows written
		// before the column existed. The partial unique index NODE_SEQ_UNIQUE_INDEX covers
		// only flagged rows (RT-37; see server-store.ts).
		seqUnique: integer('seq_unique').notNull().default(0),
		// Content-hash version of `id` (CORE-1). Null for v1 rows and rows written before
		// the column existed.
		hashVersion: integer('hash_version'),
		// Protocol v2 encryption envelope (JSON), stored opaquely. Null for plaintext.
		encrypted: text('encrypted'),
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

export const deliveryCounter = sqliteTable('delivery_counter', {
	id: integer('id').primaryKey(),
	value: integer('value').notNull(),
})

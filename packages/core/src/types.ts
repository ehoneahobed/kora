/**
 * Hybrid Logical Clock timestamp.
 * Provides a total order that respects causality without requiring synchronized clocks.
 */
export interface HLCTimestamp {
	/** Physical wall-clock time in milliseconds */
	wallTime: number
	/** Logical counter. Increments when wallTime hasn't changed since last event. */
	logical: number
	/** Node ID for tie-breaking. Ensures total order even with identical wall+logical. */
	nodeId: string
}

/** The three mutation types an operation can represent */
export type OperationType = 'insert' | 'update' | 'delete'

/**
 * The atomic unit of the entire system. Every mutation produces an Operation.
 * Operations are IMMUTABLE and CONTENT-ADDRESSED.
 */
export interface Operation {
	/** SHA-256 hash of (type + collection + recordId + data + timestamp + nodeId). Content-addressed. */
	id: string
	/** UUID v7 of the originating device. Time-sortable. */
	nodeId: string
	/** What happened */
	type: OperationType
	/** Which collection (from schema) */
	collection: string
	/** ID of the affected record. UUID v7 for inserts, existing ID for update/delete. */
	recordId: string
	/** Field values. null for delete. For updates, contains ONLY changed fields. */
	data: Record<string, unknown> | null
	/** For updates: previous values of changed fields (enables 3-way merge). null for insert/delete. */
	previousData: Record<string, unknown> | null
	/** Hybrid Logical Clock timestamp. Used for causal ordering. */
	timestamp: HLCTimestamp
	/** Monotonically increasing per node. Used in version vectors. */
	sequenceNumber: number
	/** Operation IDs this operation causally depends on (direct parents in the DAG). */
	causalDeps: string[]
	/** Schema version at time of creation. Used for migration transforms. */
	schemaVersion: number
}

/**
 * Input for creating an operation (before id and timestamp are assigned).
 */
export interface OperationInput {
	nodeId: string
	type: OperationType
	collection: string
	recordId: string
	data: Record<string, unknown> | null
	previousData: Record<string, unknown> | null
	sequenceNumber: number
	causalDeps: string[]
	schemaVersion: number
}

/** Version vector: maps nodeId to the max sequence number seen from that node */
export type VersionVector = Map<string, number>

/** Field kinds supported by the schema system */
export type FieldKind =
	| 'string'
	| 'number'
	| 'boolean'
	| 'timestamp'
	| 'richtext'
	| 'enum'
	| 'array'

/**
 * Descriptor produced by the type builder (t.string(), t.number(), etc.).
 * Represents a fully configured field definition.
 */
export interface FieldDescriptor {
	kind: FieldKind
	required: boolean
	defaultValue: unknown
	auto: boolean
	enumValues: readonly string[] | null
	itemKind: FieldKind | null
}

/**
 * Definition of a collection within the schema.
 */
export interface CollectionDefinition {
	fields: Record<string, FieldDescriptor>
	indexes: string[]
	constraints: Constraint[]
	resolvers: Record<string, CustomResolver>
}

/** Custom resolver function for tier 3 merge resolution */
export type CustomResolver = (local: unknown, remote: unknown, base: unknown) => unknown

/**
 * Constraint for tier 2 conflict resolution.
 */
export interface Constraint {
	type: 'unique' | 'capacity' | 'referential'
	fields: string[]
	where?: Record<string, unknown>
	onConflict:
		| 'first-write-wins'
		| 'last-write-wins'
		| 'priority-field'
		| 'server-decides'
		| 'custom'
	priorityField?: string
	resolve?: (local: unknown, remote: unknown, base: unknown) => unknown
}

/** Relation type between collections */
export type RelationType = 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many'

/** On-delete behavior for relations */
export type OnDeleteAction = 'cascade' | 'set-null' | 'restrict' | 'no-action'

/**
 * Definition of a relation between two collections.
 */
export interface RelationDefinition {
	from: string
	to: string
	type: RelationType
	field: string
	onDelete: OnDeleteAction
}

/**
 * The complete schema definition produced by defineSchema().
 */
export interface SchemaDefinition {
	version: number
	collections: Record<string, CollectionDefinition>
	relations: Record<string, RelationDefinition>
}

/**
 * Merge strategies available for auto-merge and constraints.
 */
export const MERGE_STRATEGIES = [
	'auto-merge',
	'lww',
	'first-write-wins',
	'server-decides',
	'custom',
] as const
export type MergeStrategy = (typeof MERGE_STRATEGIES)[number]

/**
 * Connection quality levels for adaptive sync.
 */
export const CONNECTION_QUALITIES = ['excellent', 'good', 'fair', 'poor', 'offline'] as const
export type ConnectionQuality = (typeof CONNECTION_QUALITIES)[number]

/**
 * Injectable time source for deterministic testing of clocks.
 */
export interface TimeSource {
	now(): number
}

/**
 * Injectable random source for deterministic testing of UUID generation.
 */
export interface RandomSource {
	getRandomValues<T extends ArrayBufferView>(array: T): T
}

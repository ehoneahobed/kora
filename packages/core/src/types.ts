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

/** Supported atomic operation types for intent-preserving field updates */
export type AtomicOpType = 'increment' | 'max' | 'min' | 'append' | 'remove'

/**
 * Atomic operation stored in an Operation's atomicOps field.
 * This is the serializable form that persists in the operation log.
 */
export interface AtomicOp {
	readonly type: AtomicOpType
	readonly value: unknown
}

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
	/** Atomic operation intents for fields in data (e.g., increment, max). Present only when atomic ops were used. */
	atomicOps?: Record<string, AtomicOp>
	/** Groups this operation with others in an atomic transaction. Not part of the content hash. */
	transactionId?: string
	/** Human-readable name for the mutation group (e.g., 'complete-sale'). For DevTools display. */
	mutationName?: string
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
	/** Atomic operation intents for fields in data (e.g., increment, max). */
	atomicOps?: Record<string, AtomicOp>
	/** Groups this operation with others in an atomic transaction. Not part of the content hash. */
	transactionId?: string
	/** Human-readable name for the mutation group (e.g., 'complete-sale'). For DevTools display. */
	mutationName?: string
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
 * Comprehensive sync diagnostics snapshot.
 * Provides connection, latency, throughput, queue, and error metrics
 * for monitoring and DevTools integration.
 */
export interface SyncDiagnosticsSnapshot {
	// Connection
	/** Current developer-facing sync status */
	status:
		| 'connected'
		| 'syncing'
		| 'synced'
		| 'offline'
		| 'error'
		| 'schema-mismatch'
		| 'clock-error'
	/** Timestamp when the current connection was established, or null if disconnected */
	connectedAt: number | null
	/** Timestamp when the last disconnection occurred, or null if never disconnected */
	disconnectedAt: number | null
	/** Number of reconnection attempts since last successful connection */
	reconnectAttempts: number

	// Latency
	/** Current round-trip time in milliseconds */
	rttMs: number
	/** Median (50th percentile) RTT over the sliding window */
	rttP50Ms: number
	/** 95th percentile RTT over the sliding window */
	rttP95Ms: number
	/** 99th percentile RTT over the sliding window */
	rttP99Ms: number

	// Throughput
	/** Total operations sent during this session */
	operationsSent: number
	/** Total operations received during this session */
	operationsReceived: number
	/** Total bytes sent during this session */
	bytesSent: number
	/** Total bytes received during this session */
	bytesReceived: number

	// Queue
	/** Number of operations waiting to be sent */
	pendingOperations: number
	/** Estimated bytes in the outbound queue */
	outboundQueueSize: number

	// Sync Progress
	/** Timestamp of the last successful sync, or null if never synced */
	lastSyncedAt: number | null
	/** Duration of the last complete sync cycle in ms, or null if no cycle completed */
	syncDuration: number | null
	/** Whether the initial sync (full delta exchange) has completed */
	initialSyncComplete: boolean
	/** Progress of the initial sync as a 0-1 ratio */
	initialSyncProgress: number

	// Errors
	/** Description of the last error, or null if no error occurred */
	lastError: string | null
	/** Total number of errors during this session */
	errorCount: number

	// Connection Quality
	/** Assessed connection quality level */
	quality: 'excellent' | 'good' | 'fair' | 'poor' | 'offline'
	/** Estimated effective bandwidth in bytes per second, or null if not yet measured */
	effectiveBandwidth: number | null
}

/** Built-in field merge strategies that can be declared in the schema. */
export type FieldMergeStrategy =
	| 'lww'
	| 'counter'
	| 'max'
	| 'min'
	| 'union'
	| 'append-only'
	| 'server-authoritative'

/** Map of state to allowed next states for state machine constraints */
export type TransitionMap = Record<string, string[]>

/**
 * A state machine constraint extracted from the schema.
 * Used by merge and validation to enforce valid state transitions.
 */
export interface StateMachineConstraint {
	/** The enum field this constraint controls */
	field: string
	/** The collection this constraint applies to */
	collection: string
	/** Map of state to allowed next states */
	transitions: TransitionMap
}

/**
 * Result of validating a state transition.
 */
export interface TransitionValidationResult {
	/** Whether the transition is allowed */
	valid: boolean
	/** The source state */
	from: string
	/** The target state */
	to: string
	/** The field being transitioned */
	field: string
	/** The collection containing the field */
	collection: string
	/** All allowed target states from the source state */
	allowedTargets: string[]
}

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
	/** Declared merge strategy. Defaults to kind-appropriate strategy when undefined. */
	mergeStrategy: FieldMergeStrategy | null
	/** State machine transition map for enum fields. Null if no transitions declared. */
	transitions: TransitionMap | null
}

/**
 * Defines a state machine on an enum field, constraining valid state transitions.
 *
 * When a state machine is defined on a collection, mutations and merges
 * enforce that the controlled field only moves along declared transitions.
 *
 * @example
 * ```typescript
 * stateMachine: {
 *   field: 'status',
 *   transitions: {
 *     draft: ['pending', 'cancelled'],
 *     pending: ['confirmed', 'cancelled'],
 *     confirmed: ['shipped'],
 *     shipped: ['delivered'],
 *     delivered: [],
 *     cancelled: [],
 *   },
 *   onInvalidTransition: 'reject',
 * }
 * ```
 */
export interface StateMachineDefinition {
	/** The enum field this state machine controls */
	field: string
	/** Map of state to allowed next states */
	transitions: Record<string, string[]>
	/** What to do when an invalid transition is attempted */
	onInvalidTransition: 'reject' | 'last-valid-state'
}

/**
 * Definition of a collection within the schema.
 */
export interface CollectionDefinition {
	fields: Record<string, FieldDescriptor>
	indexes: string[]
	constraints: Constraint[]
	resolvers: Record<string, CustomResolver>
	/** Scope fields for sync filtering. Only records matching the client's scope values are synced. */
	scope: string[]
	/** Optional state machine constraining transitions on an enum field */
	stateMachine?: StateMachineDefinition
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
 * Declarative sync filter for a collection.
 *
 * `where` maps record field names to scope value keys. Use `true` to bind a field
 * to a scope value with the same name (e.g. `{ userId: true }`).
 */
export interface SyncRuleDefinition {
	where: Record<string, string>
}

/**
 * The complete schema definition produced by defineSchema().
 */
export interface SchemaDefinition {
	version: number
	collections: Record<string, CollectionDefinition>
	relations: Record<string, RelationDefinition>
	/** Schema migrations keyed by target version. */
	migrations: Record<number, import('./migrations/migration-builder').MigrationDefinition>
	/**
	 * Declarative partial-sync rules per collection.
	 * When present, only listed collections (plus legacy `scope` collections) sync.
	 */
	sync?: Record<string, SyncRuleDefinition>
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

/**
 * Configuration for an offline-safe sequence.
 *
 * Sequences produce monotonically increasing, collision-free identifiers
 * that work across offline devices. Each device maintains its own counter
 * scoped by (name, scope, nodeId).
 *
 * Format tokens available:
 * - `{date}` → YYYYMMDD
 * - `{node4}` → first 4 chars of nodeId
 * - `{node8}` → first 8 chars of nodeId
 * - `{seq}` → zero-padded counter (4 digits)
 * - `{seq:N}` → zero-padded counter with N digits
 *
 * @example
 * ```typescript
 * await app.sequences.next('receipt', {
 *   scope: storeId,
 *   format: 'S-{date}-{node4}-{seq}',
 * })
 * // → "S-20260508-a1b2-0042"
 * ```
 */
export interface SequenceConfig {
	/** Namespace within the sequence (e.g., a storeId or orgId). Defaults to ''. */
	scope?: string
	/** Format template. Defaults to `{name}-{seq:4}`. */
	format?: string
	/** Starting counter value. Defaults to 1. */
	startAt?: number
}

// @korajs/core — public API
// Every export here is a public API commitment. Be explicit.

// === Types ===
export type {
	AtomicOp,
	AtomicOpType,
	CollectionDefinition,
	ConnectionQuality,
	Constraint,
	CustomResolver,
	FieldDescriptor,
	FieldKind,
	FieldMergeStrategy,
	HLCTimestamp,
	MergeStrategy,
	OnDeleteAction,
	Operation,
	OperationInput,
	OperationType,
	RandomSource,
	RelationDefinition,
	RelationType,
	SchemaDefinition,
	SequenceConfig,
	TimeSource,
	VersionVector,
} from './types'

export { CONNECTION_QUALITIES, MERGE_STRATEGIES } from './types'

// === Errors ===
export {
	ClockDriftError,
	KoraError,
	MergeConflictError,
	OperationError,
	SchemaValidationError,
	StorageError,
	SyncError,
} from './errors/errors'

// === Clock ===
export { HybridLogicalClock } from './clock/hlc'

// === Identifiers ===
export { extractTimestamp, generateUUIDv7, isValidUUIDv7 } from './identifiers/uuid-v7'

// === Operations ===
export {
	createOperation,
	isValidOperation,
	verifyOperationIntegrity,
} from './operations/operation'

// === Atomic Operations ===
export {
	isAtomicOp,
	op,
	resolveAtomicOp,
	toAtomicOp,
} from './operations/atomic-ops'
export type { AtomicOpSentinel } from './operations/atomic-ops'

// === Schema ===
export { defineSchema } from './schema/define'
export type {
	CollectionInput,
	ConstraintInput,
	RelationInput,
	SchemaInput,
	TypedSchemaDefinition,
} from './schema/define'
export { generateFullDDL, generateSQL } from './schema/sql-gen'
export { ArrayFieldBuilder, EnumFieldBuilder, FieldBuilder, t } from './schema/types'
export { validateRecord } from './schema/validation'

// === Type Inference ===
export type {
	FieldKindToType,
	InferFieldType,
	InferInsertInput,
	InferRecord,
	InferUpdateInput,
} from './schema/infer'

// === Version Vectors ===
export {
	advanceVector,
	computeDelta,
	createVersionVector,
	deserializeVector,
	dominates,
	mergeVectors,
	serializeVector,
	vectorsEqual,
} from './version-vector/version-vector'
export type { OperationLog } from './version-vector/version-vector'

// === Scopes ===
export { buildScopeMap } from './scopes/build-scope-map'
export type { ScopeMap } from './scopes/build-scope-map'

// === Sequences ===
export { defaultSequenceFormat, formatSequenceValue } from './sequences/sequence-format'

// === Migrations ===
export { MigrationBuilder, migrate } from './migrations/migration-builder'
export type { MigrationDefinition, MigrationStep } from './migrations/migration-builder'
export { migrationStepsToSQL } from './migrations/migration-sql'

// === Events ===
export type {
	KoraEvent,
	KoraEventByType,
	KoraEventEmitter,
	KoraEventListener,
	KoraEventType,
	MergeTrace,
} from './events/events'

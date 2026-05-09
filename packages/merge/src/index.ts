// @korajs/merge — public API
// Every export here is a public API commitment. Be explicit.

// === Types ===
export type {
	ConstraintContext,
	ConstraintViolation,
	FieldMergeResult,
	MergeInput,
	MergeResult,
} from './types'

// === Strategies ===
export { lastWriteWins, type LWWResult } from './strategies/lww'
export { addWinsSet } from './strategies/add-wins-set'
export {
	mergeAtomicOps,
	type AtomicMergeResult,
	type AtomicMergeFallback,
} from './strategies/atomic-merge'
export { mergeRichtext, richtextToString, stringToRichtextUpdate } from './strategies/yjs-richtext'
export {
	appendOnlyMerge,
	applySchemaStrategy,
	counterMerge,
	maxMerge,
	minMerge,
	serverAuthoritativeMerge,
} from './strategies/schema-strategies'

// === Field Merger ===
export { mergeField } from './engine/field-merger'

// === Constraint Checking ===
export { checkConstraints } from './constraints/constraint-checker'
export { resolveConstraintViolation, type ConstraintResolution } from './constraints/resolvers'

// === Referential Integrity ===
export {
	buildMergeRelationLookup,
	checkReferentialIntegrityOnDelete,
	resolveDeleteVsInsertConflict,
} from './constraints/referential-integrity'
export type {
	DeleteVsInsertResolution,
	MergeIncomingRelation,
	ReferentialCheckResult,
	ReferentialMergeContext,
	SideEffectOp,
} from './constraints/referential-integrity'

// === Merge Engine ===
export { MergeEngine } from './engine/merge-engine'

// @korajs/merge — public API
// Every export here is a public API commitment. Be explicit.

// === Types ===
export type {
	ConstraintContext,
	ConstraintViolation,
} from './types'

// === Rich text ===
export {
	mergeRichtext,
	mergeRichtextUpdate,
	richtextToString,
	stringToRichtextUpdate,
	type RichtextUpdateMerge,
} from './strategies/yjs-richtext'

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

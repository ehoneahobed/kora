// @kora/merge — public API
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
export { mergeRichtext, richtextToString, stringToRichtextUpdate } from './strategies/yjs-richtext'

// === Field Merger ===
export { mergeField } from './engine/field-merger'

// === Constraint Checking ===
export { checkConstraints } from './constraints/constraint-checker'
export { resolveConstraintViolation, type ConstraintResolution } from './constraints/resolvers'

// === Merge Engine ===
export { MergeEngine } from './engine/merge-engine'

// @korajs/merge — internal exports for other @kora packages
// These are NOT part of the public API. Only import from other @kora packages.

export { mergeField } from './engine/field-merger'
export { checkConstraints } from './constraints/constraint-checker'
export { resolveConstraintViolation } from './constraints/resolvers'
export type {
	ConstraintContext,
	ConstraintViolation,
	MergeInput,
	MergeResult,
	FieldMergeResult,
} from './types'

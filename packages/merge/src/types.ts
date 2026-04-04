import type { CollectionDefinition, Constraint, HLCTimestamp, Operation } from '@kora/core'
import type { MergeTrace } from '@kora/core'

/**
 * Input to the merge engine when two concurrent operations conflict.
 */
export interface MergeInput {
	/** The locally-originated operation */
	local: Operation
	/** The remotely-originated operation */
	remote: Operation
	/** Full record state before either operation was applied */
	baseState: Record<string, unknown>
	/** Schema definition for the collection being merged */
	collectionDef: CollectionDefinition
}

/**
 * Output of the merge engine after resolving all field conflicts.
 */
export interface MergeResult {
	/** The resolved field values after merging */
	mergedData: Record<string, unknown>
	/** One trace per conflicting field (for DevTools) */
	traces: MergeTrace[]
	/** Which operation's values dominate overall, or 'merged' if mixed */
	appliedOperation: 'local' | 'remote' | 'merged'
}

/**
 * Output of a single field-level merge decision.
 */
export interface FieldMergeResult {
	/** The resolved value for this field */
	value: unknown
	/** Trace of the merge decision (for DevTools) */
	trace: MergeTrace
}

/**
 * Pluggable database lookup interface for Tier 2 constraint checking.
 * @kora/store provides the implementation at runtime; the merge package
 * only depends on this interface, keeping it storage-agnostic.
 */
export interface ConstraintContext {
	/** Query records matching the given filter in a collection */
	queryRecords(
		collection: string,
		where: Record<string, unknown>,
	): Promise<Record<string, unknown>[]>

	/** Count records matching the given filter in a collection */
	countRecords(collection: string, where: Record<string, unknown>): Promise<number>
}

/**
 * Describes a constraint that was violated after auto-merge.
 */
export interface ConstraintViolation {
	/** The constraint definition that was violated */
	constraint: Constraint
	/** The field(s) involved in the violation */
	fields: string[]
	/** Human-readable description of the violation */
	message: string
}

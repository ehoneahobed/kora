import type { Constraint } from '@korajs/core'

/**
 * Pluggable database lookup interface for Tier 2 constraint checking.
 * @korajs/store provides the implementation at runtime; the merge package
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

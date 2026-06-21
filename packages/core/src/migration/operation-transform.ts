import type { Operation } from '../types'

/**
 * Transforms operations created under an older schema version so they are valid
 * after a schema upgrade. Used during sync when client and server schema versions differ
 * but remain within the server's supported range.
 */
export interface OperationTransform {
	/** Schema version the operation was authored against */
	readonly fromVersion: number
	/** Target schema version after transformation */
	readonly toVersion: number
	/**
	 * Transform a single operation. Return `null` to drop operations that cannot be migrated.
	 */
	transform(operation: Operation): Operation | null
}

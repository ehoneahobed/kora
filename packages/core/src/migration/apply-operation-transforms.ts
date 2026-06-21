import type { Operation } from '../types'
import type { OperationTransform } from './operation-transform'

const MAX_TRANSFORM_STEPS = 32

/**
 * Apply registered transforms until the operation matches `targetSchemaVersion`.
 * Returns null when a transform drops the operation or no path exists.
 */
export function applyOperationTransforms(
	operation: Operation,
	targetSchemaVersion: number,
	transforms: readonly OperationTransform[],
): Operation | null {
	let current: Operation = operation

	for (let step = 0; step < MAX_TRANSFORM_STEPS; step++) {
		if (current.schemaVersion === targetSchemaVersion) {
			return current
		}

		const transform = transforms.find(
			(candidate) => candidate.fromVersion === current.schemaVersion,
		)
		if (!transform) {
			return null
		}

		const next = transform.transform(current)
		if (next === null) {
			return null
		}
		current = next
	}

	return null
}

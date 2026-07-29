import type { QueryDescriptor } from '@korajs/store'
import type { SyncEngine, SyncQuerySubset } from '@korajs/sync'

/**
 * Extract equality-only WHERE conditions for sync query subset registration.
 * Empty queries and operator-only filters are registered as collection-wide
 * subsets. That may over-deliver within the server-authorized scope, but it is
 * the only correctness-preserving representation until sync subsets support the
 * full query predicate language.
 */
export function queryDescriptorToSyncSubset(descriptor: QueryDescriptor): SyncQuerySubset {
	const where: Record<string, unknown> = {}
	const skippedFields: string[] = []

	for (const [field, value] of Object.entries(descriptor.where)) {
		if (value === null || value === undefined) {
			where[field] = value
			continue
		}
		if (typeof value !== 'object' || Array.isArray(value)) {
			where[field] = value
			continue
		}
		skippedFields.push(field)
	}

	if (skippedFields.length > 0 && typeof console !== 'undefined') {
		console.warn(
			`[Kora] Sync query subset widened non-equality filters on ${descriptor.collection}: ${skippedFields.join(', ')}. Only plain equality WHERE clauses are represented for incremental sync; unsupported predicates sync the containing collection subset and are filtered locally.`,
		)
	}

	return {
		collection: descriptor.collection,
		where,
	}
}

/**
 * Creates a store hook that registers live query filters with the sync engine.
 */
export function createSyncQuerySubscriptionHook(
	getSyncEngine: () => SyncEngine | null,
): (descriptor: QueryDescriptor) => () => void {
	return (descriptor) => {
		const subset = queryDescriptorToSyncSubset(descriptor)
		const engine = getSyncEngine()
		if (!engine) {
			return () => {}
		}

		return engine.registerQuerySubset(subset)
	}
}

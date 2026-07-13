import type { QueryDescriptor } from '@korajs/store'
import type { SyncEngine, SyncQuerySubset } from '@korajs/sync'

/**
 * Extract equality-only WHERE conditions for sync query subset registration.
 * Operator-based filters (e.g. `$gt`) are not representable as sync subsets yet.
 */
export function queryDescriptorToSyncSubset(descriptor: QueryDescriptor): SyncQuerySubset | null {
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
			`[Kora] Sync query subset omitted non-equality filters on ${descriptor.collection}: ${skippedFields.join(', ')}. ` +
				'Only plain equality WHERE clauses are registered for incremental sync.',
		)
	}

	if (Object.keys(where).length === 0) {
		return null
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
		if (!subset) {
			return () => {}
		}

		const engine = getSyncEngine()
		if (!engine) {
			return () => {}
		}

		return engine.registerQuerySubset(subset)
	}
}

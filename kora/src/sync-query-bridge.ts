import type { QueryDescriptor } from '@korajs/store'
import type { SyncEngine } from '@korajs/sync'
import type { SyncQuerySubset } from '@korajs/sync'

/**
 * Extract equality-only WHERE conditions for sync query subset registration.
 * Operator-based filters (e.g. `$gt`) are not representable as sync subsets yet.
 */
export function queryDescriptorToSyncSubset(descriptor: QueryDescriptor): SyncQuerySubset | null {
	const where: Record<string, unknown> = {}

	for (const [field, value] of Object.entries(descriptor.where)) {
		if (value === null || value === undefined) {
			where[field] = value
			continue
		}
		if (typeof value !== 'object' || Array.isArray(value)) {
			where[field] = value
		}
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

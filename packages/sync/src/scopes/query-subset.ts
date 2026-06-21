import type { Operation } from '@korajs/core'

/**
 * A live query filter that narrows which operations sync for a collection.
 */
export interface SyncQuerySubset {
	collection: string
	where: Record<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return null
	}
	return value as Record<string, unknown>
}

function buildSnapshot(
	op: Operation,
	fullRecord?: Record<string, unknown> | null,
): Record<string, unknown> | null {
	const previous = asRecord(op.previousData)
	const next = asRecord(op.data)

	if (!previous && !next && !fullRecord) {
		return null
	}

	return {
		...(fullRecord ?? {}),
		...(previous ?? {}),
		...(next ?? {}),
	}
}

function recordMatchesWhere(
	snapshot: Record<string, unknown>,
	where: Record<string, unknown>,
): boolean {
	for (const [field, expected] of Object.entries(where)) {
		if (snapshot[field] !== expected) {
			return false
		}
	}
	return true
}

/**
 * Returns true when an operation matches at least one active query subset
 * for its collection. Collections without query subsets pass through.
 */
export function operationMatchesQuerySubsets(
	op: Operation,
	subsets: SyncQuerySubset[] | undefined,
	fullRecord?: Record<string, unknown> | null,
): boolean {
	if (!subsets || subsets.length === 0) {
		return true
	}

	const collectionSubsets = subsets.filter((subset) => subset.collection === op.collection)
	if (collectionSubsets.length === 0) {
		return true
	}

	const snapshot = buildSnapshot(op, fullRecord)
	if (!snapshot) {
		return false
	}

	return collectionSubsets.some((subset) => recordMatchesWhere(snapshot, subset.where))
}

/**
 * Deduplicate query subsets by collection + where JSON key.
 */
export function dedupeQuerySubsets(subsets: SyncQuerySubset[]): SyncQuerySubset[] {
	const seen = new Set<string>()
	const result: SyncQuerySubset[] = []

	for (const subset of subsets) {
		const key = `${subset.collection}:${JSON.stringify(subset.where)}`
		if (seen.has(key)) {
			continue
		}
		seen.add(key)
		result.push(subset)
	}

	return result
}

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
	// An empty predicate is collection-wide. It must also admit fieldless deletes,
	// which intentionally have no data snapshot to evaluate.
	if (collectionSubsets.some((subset) => Object.keys(subset.where).length === 0)) {
		return true
	}

	const snapshot = buildSnapshot(op, fullRecord)
	if (!snapshot) {
		return false
	}

	return collectionSubsets.some((subset) => recordMatchesWhere(snapshot, subset.where))
}

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue)
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, entry]) => entry !== undefined)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, entry]) => [key, stableValue(entry)]),
		)
	}
	return value
}

function whereContains(broad: Record<string, unknown>, narrow: Record<string, unknown>): boolean {
	return Object.entries(broad).every(
		([field, expected]) =>
			JSON.stringify(stableValue(narrow[field])) === JSON.stringify(stableValue(expected)),
	)
}

/** Canonicalize equality subsets and remove subsets already covered by a broader one. */
export function dedupeQuerySubsets(subsets: SyncQuerySubset[]): SyncQuerySubset[] {
	const normalized = subsets.map((subset) => ({
		collection: subset.collection,
		where: stableValue(subset.where) as Record<string, unknown>,
	}))
	const result: SyncQuerySubset[] = []
	for (const candidate of normalized) {
		if (
			normalized.some(
				(other) =>
					other !== candidate &&
					other.collection === candidate.collection &&
					whereContains(other.where, candidate.where) &&
					(Object.keys(other.where).length < Object.keys(candidate.where).length ||
						JSON.stringify(other.where) === JSON.stringify(candidate.where)),
			)
		) {
			const duplicateAlreadyKept = result.some(
				(item) =>
					item.collection === candidate.collection &&
					JSON.stringify(item.where) === JSON.stringify(candidate.where),
			)
			if (
				duplicateAlreadyKept ||
				normalized.some(
					(other) =>
						other !== candidate &&
						other.collection === candidate.collection &&
						Object.keys(other.where).length < Object.keys(candidate.where).length &&
						whereContains(other.where, candidate.where),
				)
			)
				continue
		}
		if (
			!result.some(
				(item) =>
					item.collection === candidate.collection &&
					JSON.stringify(item.where) === JSON.stringify(candidate.where),
			)
		)
			result.push(candidate)
	}
	return result.sort((a, b) =>
		`${a.collection}:${JSON.stringify(a.where)}`.localeCompare(
			`${b.collection}:${JSON.stringify(b.where)}`,
		),
	)
}

/** True when every record selected by `narrow` is also selected by `broad`. */
export function querySubsetContains(broad: SyncQuerySubset[], narrow: SyncQuerySubset[]): boolean {
	const collections = new Set([
		...broad.map((subset) => subset.collection),
		...narrow.map((subset) => subset.collection),
	])
	for (const collection of collections) {
		const broadForCollection = broad.filter((subset) => subset.collection === collection)
		const narrowForCollection = narrow.filter((subset) => subset.collection === collection)
		// No predicate for a collection means that collection is unrestricted.
		if (narrowForCollection.length === 0) {
			if (broadForCollection.length > 0) return false
			continue
		}
		if (broadForCollection.length === 0) continue
		if (
			!narrowForCollection.every((candidate) =>
				broadForCollection.some((other) => whereContains(other.where, candidate.where)),
			)
		)
			return false
	}
	return true
}

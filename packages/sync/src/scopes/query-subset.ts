import type { Operation } from '@korajs/core'
import { type ScopeSnapshotOptions, buildScopeSnapshot } from './scope-snapshot'

/**
 * A live query filter that narrows which operations sync for a collection.
 */
export interface SyncQuerySubset {
	collection: string
	where: Record<string, unknown>
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
 *
 * The writer's `previousData` is ignored unless `options.includePreviousData` is
 * set (see {@link ScopeSnapshotOptions}); the server never sets it.
 */
export function operationMatchesQuerySubsets(
	op: Operation,
	subsets: SyncQuerySubset[] | undefined,
	fullRecord?: Record<string, unknown> | null,
	options: ScopeSnapshotOptions = {},
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

	// Shared snapshot: identity always comes from op.recordId, never from op fields.
	const snapshot = buildScopeSnapshot(op, fullRecord, options)
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

interface CanonicalSubset {
	collection: string
	where: Record<string, unknown>
	/** The canonical where, as JSON (its identity). */
	key: string
	/** Field name to the field's canonical value as JSON. */
	fields: Map<string, string>
}

/** Enumerate sub-dictionaries of a where with at most this many fields; scan beyond it. */
const MAX_ENUMERATED_FIELDS = 10

/**
 * Canonicalize equality subsets and remove subsets already covered by a broader one: an
 * entry is dropped when another entry of the same collection selects every record it
 * selects with fewer conditions (a proper sub-dictionary of its where), and duplicates are
 * kept once. Runs on every handshake over a list the client sends, so it indexes the
 * entries by their canonical form instead of comparing every pair: a where with few fields
 * looks up each of its sub-dictionaries, a larger one scans only entries with fewer fields.
 */
export function dedupeQuerySubsets(subsets: SyncQuerySubset[]): SyncQuerySubset[] {
	const byCollection = indexByCollection(subsets)
	const result: SyncQuerySubset[] = []
	for (const entries of byCollection.values()) {
		const all = [...entries.values()]
		for (const candidate of all) {
			if (!coveredByBroader(candidate, entries, all)) {
				result.push({ collection: candidate.collection, where: candidate.where })
			}
		}
	}
	// Each key computed once, not twice per comparison.
	const keyed = result.map((subset) => ({
		subset,
		key: `${subset.collection}:${JSON.stringify(subset.where)}`,
	}))
	keyed.sort((a, b) => a.key.localeCompare(b.key))
	return keyed.map((entry) => entry.subset)
}

/** The distinct canonical subsets of each collection, by canonical where. */
function indexByCollection(subsets: SyncQuerySubset[]): Map<string, Map<string, CanonicalSubset>> {
	const byCollection = new Map<string, Map<string, CanonicalSubset>>()
	for (const subset of subsets) {
		const where = stableValue(subset.where) as Record<string, unknown>
		const key = JSON.stringify(where)
		let entries = byCollection.get(subset.collection)
		if (!entries) {
			entries = new Map()
			byCollection.set(subset.collection, entries)
		}
		if (entries.has(key)) continue
		const fields = new Map<string, string>()
		for (const [field, value] of Object.entries(where)) fields.set(field, JSON.stringify(value))
		entries.set(key, { collection: subset.collection, where, key, fields })
	}
	return byCollection
}

/** True when another entry's where is a proper sub-dictionary of the candidate's. */
function coveredByBroader(
	candidate: CanonicalSubset,
	entries: Map<string, CanonicalSubset>,
	all: CanonicalSubset[],
): boolean {
	const names = [...candidate.fields.keys()]
	if (names.length === 0) return false
	if (names.length <= MAX_ENUMERATED_FIELDS) {
		const full = (1 << names.length) - 1
		for (let mask = 0; mask < full; mask++) {
			const sub: Record<string, unknown> = {}
			for (let bit = 0; bit < names.length; bit++) {
				const name = names[bit]
				if (name !== undefined && mask & (1 << bit)) sub[name] = candidate.where[name]
			}
			if (entries.has(JSON.stringify(sub))) return true
		}
		return false
	}
	return all.some(
		(other) =>
			other.fields.size < candidate.fields.size &&
			[...other.fields].every(([field, value]) => candidate.fields.get(field) === value),
	)
}

/** True when every record selected by `narrow` is also selected by `broad`. */
export function querySubsetContains(broad: SyncQuerySubset[], narrow: SyncQuerySubset[]): boolean {
	const broadIndex = indexByCollection(broad)
	const narrowIndex = indexByCollection(narrow)
	const collections = new Set([...broadIndex.keys(), ...narrowIndex.keys()])
	for (const collection of collections) {
		const broadEntries = broadIndex.get(collection)
		const narrowEntries = narrowIndex.get(collection)
		// No predicate for a collection means that collection is unrestricted.
		if (!narrowEntries) {
			if (broadEntries) return false
			continue
		}
		if (!broadEntries) continue
		const all = [...broadEntries.values()]
		for (const candidate of narrowEntries.values()) {
			if (!broadEntries.has(candidate.key) && !coveredByBroader(candidate, broadEntries, all)) {
				return false
			}
		}
	}
	return true
}

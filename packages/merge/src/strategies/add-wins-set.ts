import { mergeArraySet } from '@korajs/core'

/**
 * Add-wins set merge strategy for array fields (three-way, base-relative).
 *
 * When two sides concurrently modify an array, every element either side ADDED
 * survives, and every base element either side REMOVED is removed. An element
 * one side left unchanged never resurrects an element the other side removed
 * (MERGE-1, NEW-MERGE-1): "unchanged" is not a vote to keep it.
 *
 * Algorithm:
 *   result = (local ∩ remote) ∪ (local − base) ∪ (remote − base)
 *
 * Equivalently: a base element is kept only if BOTH sides kept it; a non-base
 * element is kept if EITHER side added it.
 *
 * Ordering is role-independent (the two devices performing this merge call
 * opposite sides "local"): kept base elements first, in base order, then every
 * other element sorted by its serialized form.
 *
 * Uses JSON.stringify for element comparison to handle primitives and objects.
 * Delegates to `mergeArraySet` in `@korajs/core`.
 *
 * Interim (S1): this is still a pairwise merge. W7 replaces it with a per-element
 * LWW set whose result is independent of merge order.
 *
 * @deprecated W7 (beta.13): arrays fold as an occurrence-indexed LWW element
 * multiset in `@korajs/core`. Kept for `experimental.legacyMerge` (one beta).
 *
 * @param localArray - The local array after local modifications
 * @param remoteArray - The remote array after remote modifications
 * @param baseArray - The array state before either modification
 * @returns The merged array
 */
export function addWinsSet(
	localArray: unknown[],
	remoteArray: unknown[],
	baseArray: unknown[],
): unknown[] {
	// One implementation shared with the record fold (`replayOperationsForRecord`),
	// so the client merge and the server materialization agree.
	return mergeArraySet(localArray, remoteArray, baseArray)
}

/**
 * Add-wins set merge strategy for array fields.
 *
 * When two sides concurrently modify an array, this strategy preserves all
 * additions from both sides. An element is only removed from the result if
 * BOTH sides independently removed it. This prevents data loss: if one side
 * adds an element while another removes a different element, both changes
 * are preserved.
 *
 * Algorithm:
 *   added_local  = local - base
 *   added_remote = remote - base
 *   removed_local  = base - local
 *   removed_remote = base - remote
 *   result = (base ∪ added_local ∪ added_remote) - (removed_local ∩ removed_remote)
 *
 * Uses JSON.stringify for element comparison to handle primitives and objects.
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
	const serialize = (v: unknown): string => JSON.stringify(v)

	const baseSet = new Set(baseArray.map(serialize))
	const localSet = new Set(localArray.map(serialize))
	const remoteSet = new Set(remoteArray.map(serialize))

	// Elements added by each side (present in their set but not in base)
	const addedLocal = new Set<string>()
	for (const s of localSet) {
		if (!baseSet.has(s)) {
			addedLocal.add(s)
		}
	}

	const addedRemote = new Set<string>()
	for (const s of remoteSet) {
		if (!baseSet.has(s)) {
			addedRemote.add(s)
		}
	}

	// Elements removed by each side (present in base but not in their set)
	const removedLocal = new Set<string>()
	for (const s of baseSet) {
		if (!localSet.has(s)) {
			removedLocal.add(s)
		}
	}

	const removedRemote = new Set<string>()
	for (const s of baseSet) {
		if (!remoteSet.has(s)) {
			removedRemote.add(s)
		}
	}

	// An element is truly removed only if BOTH sides removed it
	const removedByBoth = new Set<string>()
	for (const s of removedLocal) {
		if (removedRemote.has(s)) {
			removedByBoth.add(s)
		}
	}

	// Result = (base ∪ added_local ∪ added_remote) - removed_by_both
	// Maintain order: base elements first (preserving order), then local adds, then remote adds
	const resultSerialized = new Set<string>()
	const result: unknown[] = []

	const addIfNew = (serialized: string, value: unknown): void => {
		if (!resultSerialized.has(serialized) && !removedByBoth.has(serialized)) {
			resultSerialized.add(serialized)
			result.push(value)
		}
	}

	// Base elements (in original order, minus those removed by both)
	for (const item of baseArray) {
		addIfNew(serialize(item), item)
	}

	// Local additions (in order they appear in local array)
	for (const item of localArray) {
		const s = serialize(item)
		if (addedLocal.has(s)) {
			addIfNew(s, item)
		}
	}

	// Remote additions (in order they appear in remote array)
	for (const item of remoteArray) {
		const s = serialize(item)
		if (addedRemote.has(s)) {
			addIfNew(s, item)
		}
	}

	return result
}

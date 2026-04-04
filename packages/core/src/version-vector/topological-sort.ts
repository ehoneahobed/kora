import { HybridLogicalClock } from '../clock/hlc'
import { OperationError } from '../errors/errors'
import type { Operation } from '../types'

/**
 * Topological sort of operations based on their causal dependency DAG.
 * Uses Kahn's algorithm with deterministic tie-breaking via HLC timestamp.
 * Time complexity: O(V + E) where V = operations, E = causal dependency edges.
 *
 * @param operations - The operations to sort
 * @returns Operations in causal order (dependencies before dependents)
 * @throws {OperationError} If a cycle is detected in the dependency graph
 */
export function topologicalSort(operations: Operation[]): Operation[] {
	if (operations.length <= 1) return [...operations]

	// Build adjacency list and in-degree map
	const opMap = new Map<string, Operation>()
	for (const op of operations) {
		opMap.set(op.id, op)
	}

	// Only count edges where both ends are in the operation set
	const inDegree = new Map<string, number>()
	const dependents = new Map<string, string[]>()

	for (const op of operations) {
		if (!inDegree.has(op.id)) {
			inDegree.set(op.id, 0)
		}
		if (!dependents.has(op.id)) {
			dependents.set(op.id, [])
		}

		for (const depId of op.causalDeps) {
			if (opMap.has(depId)) {
				// depId -> op.id edge (depId must come before op.id)
				inDegree.set(op.id, (inDegree.get(op.id) ?? 0) + 1)
				const deps = dependents.get(depId)
				if (deps) {
					deps.push(op.id)
				} else {
					dependents.set(depId, [op.id])
				}
			}
		}
	}

	// Initialize queue with nodes that have no in-set dependencies
	// Use a sorted array for deterministic ordering (by HLC timestamp)
	const queue: Operation[] = []
	for (const op of operations) {
		if ((inDegree.get(op.id) ?? 0) === 0) {
			queue.push(op)
		}
	}
	queue.sort(compareByTimestamp)

	const result: Operation[] = []

	while (queue.length > 0) {
		// Take the earliest operation (deterministic tie-breaking by HLC)
		const current = queue.shift()
		if (!current) break
		result.push(current)

		const deps = dependents.get(current.id) ?? []
		const newlyReady: Operation[] = []

		for (const depId of deps) {
			const deg = (inDegree.get(depId) ?? 0) - 1
			inDegree.set(depId, deg)
			if (deg === 0) {
				const op = opMap.get(depId)
				if (op) newlyReady.push(op)
			}
		}

		// Sort newly ready operations and merge into queue maintaining sort order
		if (newlyReady.length > 0) {
			newlyReady.sort(compareByTimestamp)
			mergeIntoSorted(queue, newlyReady)
		}
	}

	if (result.length !== operations.length) {
		throw new OperationError(
			`Cycle detected in operation dependency graph. Sorted ${result.length} of ${operations.length} operations.`,
			{
				sortedCount: result.length,
				totalCount: operations.length,
			},
		)
	}

	return result
}

function compareByTimestamp(a: Operation, b: Operation): number {
	return HybridLogicalClock.compare(a.timestamp, b.timestamp)
}

/** Merge sorted `items` into an already-sorted `target` array, maintaining sort order. */
function mergeIntoSorted(target: Operation[], items: Operation[]): void {
	let insertIndex = 0
	for (const item of items) {
		while (insertIndex < target.length) {
			const existing = target[insertIndex]
			if (existing && compareByTimestamp(item, existing) <= 0) break
			insertIndex++
		}
		target.splice(insertIndex, 0, item)
		insertIndex++
	}
}

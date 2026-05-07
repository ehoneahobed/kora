import { HybridLogicalClock } from '../clock/hlc'
import { OperationError } from '../errors/errors'
import type { Operation } from '../types'

/**
 * Topological sort of operations based on their causal dependency DAG.
 * Uses Kahn's algorithm with a binary heap for O(V log V + E) performance.
 * Deterministic tie-breaking via HLC timestamp ensures identical output
 * regardless of input order.
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

	// Initialize min-heap with nodes that have no in-set dependencies
	const heap = new MinHeap(compareByTimestamp)
	for (const op of operations) {
		if ((inDegree.get(op.id) ?? 0) === 0) {
			heap.push(op)
		}
	}

	const result: Operation[] = []

	while (heap.size > 0) {
		// Extract the earliest operation (deterministic tie-breaking by HLC)
		const current = heap.pop()
		result.push(current)

		const deps = dependents.get(current.id) ?? []

		for (const depId of deps) {
			const deg = (inDegree.get(depId) ?? 0) - 1
			inDegree.set(depId, deg)
			if (deg === 0) {
				const op = opMap.get(depId)
				if (op) heap.push(op)
			}
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

/**
 * Binary min-heap for efficient priority queue operations.
 * push: O(log n), pop: O(log n) — replaces the O(n) sorted array approach.
 */
class MinHeap {
	private readonly data: Operation[] = []
	private readonly cmp: (a: Operation, b: Operation) => number

	constructor(comparator: (a: Operation, b: Operation) => number) {
		this.cmp = comparator
	}

	get size(): number {
		return this.data.length
	}

	push(item: Operation): void {
		this.data.push(item)
		this.bubbleUp(this.data.length - 1)
	}

	pop(): Operation {
		const top = this.data[0] as Operation
		const last = this.data.pop() as Operation
		if (this.data.length > 0) {
			this.data[0] = last
			this.sinkDown(0)
		}
		return top
	}

	private bubbleUp(index: number): void {
		while (index > 0) {
			const parentIndex = (index - 1) >> 1
			if (this.cmp(this.data[index] as Operation, this.data[parentIndex] as Operation) >= 0) break
			this.swap(index, parentIndex)
			index = parentIndex
		}
	}

	private sinkDown(index: number): void {
		const length = this.data.length
		while (true) {
			let smallest = index
			const left = 2 * index + 1
			const right = 2 * index + 2

			if (left < length && this.cmp(this.data[left] as Operation, this.data[smallest] as Operation) < 0) {
				smallest = left
			}
			if (right < length && this.cmp(this.data[right] as Operation, this.data[smallest] as Operation) < 0) {
				smallest = right
			}

			if (smallest === index) break
			this.swap(index, smallest)
			index = smallest
		}
	}

	private swap(i: number, j: number): void {
		const tmp = this.data[i] as Operation
		this.data[i] = this.data[j] as Operation
		this.data[j] = tmp
	}
}

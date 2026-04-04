import type { Operation, VersionVector } from '../types'
import { topologicalSort } from './topological-sort'

/**
 * Create an empty version vector.
 */
export function createVersionVector(): VersionVector {
	return new Map()
}

/**
 * Merge two version vectors by taking the max sequence number for each node.
 * This is commutative, associative, and idempotent.
 */
export function mergeVectors(a: VersionVector, b: VersionVector): VersionVector {
	const merged = new Map(a)
	for (const [nodeId, seq] of b) {
		merged.set(nodeId, Math.max(merged.get(nodeId) ?? 0, seq))
	}
	return merged
}

/**
 * Advance a version vector for a specific node to a new sequence number.
 * Only advances forward — if the current value is higher, no change is made.
 */
export function advanceVector(
	vector: VersionVector,
	nodeId: string,
	seq: number,
): VersionVector {
	const updated = new Map(vector)
	updated.set(nodeId, Math.max(updated.get(nodeId) ?? 0, seq))
	return updated
}

/**
 * Returns true if vector `a` dominates vector `b` — meaning `a` has seen
 * everything `b` has seen. Formally: for every nodeId in b, a[nodeId] >= b[nodeId].
 */
export function dominates(a: VersionVector, b: VersionVector): boolean {
	for (const [nodeId, bSeq] of b) {
		if ((a.get(nodeId) ?? 0) < bSeq) return false
	}
	return true
}

/**
 * Returns true if two version vectors are exactly equal.
 */
export function vectorsEqual(a: VersionVector, b: VersionVector): boolean {
	if (a.size !== b.size) return false
	for (const [nodeId, aSeq] of a) {
		if (b.get(nodeId) !== aSeq) return false
	}
	return true
}

/**
 * Operation log interface for computing deltas.
 */
export interface OperationLog {
	getRange(nodeId: string, fromSeq: number, toSeq: number): Operation[]
}

/**
 * Compute the operations that `local` has but `remote` does not.
 * Returns operations in causal (topological) order.
 *
 * @param localVector - The local version vector
 * @param remoteVector - The remote version vector
 * @param operationLog - The operation log to fetch operations from
 * @returns Operations sorted in causal order
 */
export function computeDelta(
	localVector: VersionVector,
	remoteVector: VersionVector,
	operationLog: OperationLog,
): Operation[] {
	const missing: Operation[] = []
	for (const [nodeId, localSeq] of localVector) {
		const remoteSeq = remoteVector.get(nodeId) ?? 0
		if (localSeq > remoteSeq) {
			missing.push(...operationLog.getRange(nodeId, remoteSeq + 1, localSeq))
		}
	}
	return topologicalSort(missing)
}

/**
 * Serialize a version vector to a JSON-compatible string.
 */
export function serializeVector(vector: VersionVector): string {
	const entries = [...vector.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	return JSON.stringify(entries)
}

/**
 * Deserialize a version vector from its serialized string form.
 */
export function deserializeVector(s: string): VersionVector {
	const entries = JSON.parse(s) as [string, number][]
	return new Map(entries)
}

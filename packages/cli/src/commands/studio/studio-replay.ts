import type { ParsedVersion, StudioOperation } from './db-reader'

/**
 * Time travel and causal-graph helpers for Kora Studio.
 *
 * `replayToOperation` folds the operation log up to (and including) a chosen
 * operation, in HLC order, producing the record set as it existed at that
 * causal cut. Because per-field last-write-wins is deterministic and
 * order-independent, folding in HLC order reproduces exactly the state every
 * in-order device computed at that point — the same principle the store's own
 * materializer uses, applied read-only for inspection.
 */

export interface ReplayRecord {
	id: string
	fields: Record<string, unknown>
	deleted: boolean
	lastWriterByField: Record<string, string>
}

export interface ReplayResult {
	/** Records alive (or tombstoned) at the causal cut, keyed by record id. */
	records: ReplayRecord[]
	/** How many operations were folded (position of the cut, 1-based). */
	appliedCount: number
	totalCount: number
	/** The operation at the cut. */
	cutOperation: StudioOperation | null
}

function compareVersion(a: ParsedVersion | null, b: ParsedVersion | null): number {
	if (!a || !b) {
		return a === b ? 0 : a ? 1 : -1
	}
	if (a.wallTime !== b.wallTime) {
		return a.wallTime - b.wallTime
	}
	if (a.logical !== b.logical) {
		return a.logical - b.logical
	}
	return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0
}

/** Sort operations into the HLC total order (the canonical replay order). */
export function sortByHlc(ops: StudioOperation[]): StudioOperation[] {
	return [...ops].sort((a, b) => compareVersion(a.timestamp, b.timestamp))
}

/**
 * Fold operations up to and including `upToOpId` (or all when null).
 */
export function replayToOperation(ops: StudioOperation[], upToOpId: string | null): ReplayResult {
	const ordered = sortByHlc(ops)
	let cutIndex = ordered.length - 1
	if (upToOpId !== null) {
		const found = ordered.findIndex((o) => o.id === upToOpId)
		if (found === -1) {
			throw new Error(`Operation "${upToOpId}" not found in the log`)
		}
		cutIndex = found
	}

	const records = new Map<
		string,
		{ fields: Record<string, unknown>; deleted: boolean; writers: Record<string, string> }
	>()

	for (let i = 0; i <= cutIndex; i++) {
		const operation = ordered[i]
		if (!operation) {
			continue
		}
		const writer = operation.timestamp ? shortNode(operation.timestamp.nodeId) : '?'
		if (operation.type === 'insert' && operation.data) {
			const writers: Record<string, string> = {}
			for (const field of Object.keys(operation.data)) {
				writers[field] = writer
			}
			records.set(operation.recordId, {
				fields: { ...operation.data },
				deleted: false,
				writers,
			})
		} else if (operation.type === 'update' && operation.data) {
			const existing = records.get(operation.recordId)
			if (existing) {
				for (const [field, value] of Object.entries(operation.data)) {
					existing.fields[field] = value
					existing.writers[field] = writer
				}
			} else {
				// Orphaned update (insert later in HLC order than the update is
				// impossible in HLC order — but a compacted log can lose the insert).
				const writers: Record<string, string> = {}
				for (const field of Object.keys(operation.data)) {
					writers[field] = writer
				}
				records.set(operation.recordId, {
					fields: { ...operation.data },
					deleted: false,
					writers,
				})
			}
		} else if (operation.type === 'delete') {
			const existing = records.get(operation.recordId)
			if (existing) {
				existing.deleted = true
			} else {
				records.set(operation.recordId, { fields: {}, deleted: true, writers: {} })
			}
		}
	}

	return {
		records: [...records.entries()].map(([id, r]) => ({
			id,
			fields: r.fields,
			deleted: r.deleted,
			lastWriterByField: r.writers,
		})),
		appliedCount: cutIndex + 1,
		totalCount: ordered.length,
		cutOperation: ordered[cutIndex] ?? null,
	}
}

// ── Causal DAG ───────────────────────────────────────────────────────────────

export interface DagNode {
	id: string
	type: string
	recordId: string
	nodeId: string
	shortNodeId: string
	sequenceNumber: number
	wallTime: number
	/** Column in the layered layout (HLC order). */
	x: number
	/** Lane index (one lane per originating device). */
	lane: number
	dataPreview: string
}

export interface DagEdge {
	from: string
	to: string
}

export interface DagResult {
	nodes: DagNode[]
	edges: DagEdge[]
	lanes: Array<{ nodeId: string; shortNodeId: string }>
}

/**
 * Build a layered causal graph from operations: x = HLC order, one horizontal
 * lane per originating device, edges = causal dependencies. Concurrency is
 * VISIBLE as operations sharing an x-neighborhood on different lanes with no
 * path between them.
 */
export function buildCausalDag(ops: StudioOperation[]): DagResult {
	const ordered = sortByHlc(ops)
	const laneByNode = new Map<string, number>()
	const lanes: Array<{ nodeId: string; shortNodeId: string }> = []

	for (const operation of ordered) {
		if (!laneByNode.has(operation.nodeId)) {
			laneByNode.set(operation.nodeId, lanes.length)
			lanes.push({ nodeId: operation.nodeId, shortNodeId: shortNode(operation.nodeId) })
		}
	}

	const idSet = new Set(ordered.map((o) => o.id))
	const nodes: DagNode[] = ordered.map((operation, index) => ({
		id: operation.id,
		type: operation.type,
		recordId: operation.recordId,
		nodeId: operation.nodeId,
		shortNodeId: shortNode(operation.nodeId),
		sequenceNumber: operation.sequenceNumber,
		wallTime: operation.timestamp?.wallTime ?? 0,
		x: index,
		lane: laneByNode.get(operation.nodeId) ?? 0,
		dataPreview: operation.data ? JSON.stringify(operation.data).slice(0, 80) : '',
	}))

	const edges: DagEdge[] = []
	for (const operation of ordered) {
		for (const dep of operation.causalDeps) {
			if (idSet.has(dep)) {
				edges.push({ from: dep, to: operation.id })
			}
		}
	}

	return { nodes, edges, lanes }
}

function shortNode(nodeId: string): string {
	return nodeId.length > 8 ? nodeId.slice(-8) : nodeId
}

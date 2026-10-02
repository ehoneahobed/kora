import {
	HybridLogicalClock,
	OperationError,
	foldRecord,
	isFoldStateLive,
	materialize,
} from '@korajs/core'
import type { CollectionDefinition, Operation, SchemaDefinition } from '@korajs/core'
import { topologicalSort } from '@korajs/core/internal'
import { mergeYjsUpdates } from '../fold/record-folder'
import { decodeRichtextFieldsFromOpData } from '../serialization/op-data-encoding'
import type { CollectionRecord } from '../types'

/**
 * In-memory materialized state at a causal cut in the operation log.
 * Read-only — does not mutate the live store.
 */
export interface ReplaySnapshot {
	/** The operation whose causal past was replayed (inclusive). */
	targetOperation: Operation
	/** Operations applied in causal order (ancestors + target). */
	operationsApplied: Operation[]
	/** Non-deleted records per collection after replay. */
	collections: Record<string, CollectionRecord[]>
	/** Look up a single record at the replay cut. Returns null if deleted or missing. */
	findRecord(collection: string, recordId: string): CollectionRecord | null
}

interface MutableReplayRecord {
	id: string
	fields: Record<string, unknown>
	deleted: boolean
	createdAt: number
	updatedAt: number
}

type ReplayMemoryState = Map<string, Map<string, MutableReplayRecord>>

/**
 * Collect the target operation and all causal ancestors present in `allOps`.
 *
 * @param aliases - Old operation id -> the id it was re-emitted under (a renumbered
 *   version-2 operation, `_kora_seq_conflicts.reemitted_as`). A dependent the server
 *   already stored keeps naming the old id; the alias resolves it.
 */
export function collectCausalClosure(
	allOps: Operation[],
	targetOperationId: string,
	aliases: ReadonlyMap<string, string> = new Map(),
): Operation[] {
	const opMap = new Map<string, Operation>()
	for (const op of allOps) {
		opMap.set(op.id, op)
	}

	const target = opMap.get(targetOperationId)
	if (!target) {
		throw new OperationError(
			`Operation "${targetOperationId}" not found in the local operation log`,
			{
				operationId: targetOperationId,
			},
		)
	}

	const included = new Set<string>()
	const stack: string[] = [targetOperationId]

	while (stack.length > 0) {
		const id = stack.pop()
		if (id === undefined || included.has(id)) {
			continue
		}
		included.add(id)
		const op = opMap.get(id)
		if (!op) {
			continue
		}
		for (const dep of op.causalDeps) {
			let depId = dep
			// Follow re-emissions (a renumbered op may itself have been renumbered again).
			for (let hops = 0; !opMap.has(depId) && aliases.has(depId) && hops < 8; hops++) {
				depId = aliases.get(depId) ?? depId
			}
			if (opMap.has(depId)) {
				stack.push(depId)
			}
		}
	}

	const subset = allOps.filter((op) => included.has(op.id))
	return topologicalSort(subset)
}

/**
 * Replay a causal subset of operations into an in-memory materialized snapshot.
 * Does not use the merge engine — concurrent ops outside the causal cut are excluded.
 */
export function buildReplaySnapshot(
	schema: SchemaDefinition,
	allOps: Operation[],
	targetOperationId: string,
	aliases: ReadonlyMap<string, string> = new Map(),
): ReplaySnapshot {
	const operationsApplied = collectCausalClosure(allOps, targetOperationId, aliases)
	const targetOperation = operationsApplied.find((op) => op.id === targetOperationId)
	if (!targetOperation) {
		throw new OperationError(`Operation "${targetOperationId}" not found after causal sort`, {
			operationId: targetOperationId,
		})
	}

	const memory = foldIntoMemory(operationsApplied, schema)

	const collections = materializeCollections(schema, memory)

	return {
		targetOperation,
		operationsApplied,
		collections,
		findRecord(collection: string, recordId: string): CollectionRecord | null {
			const colMap = memory.get(collection)
			const record = colMap?.get(recordId)
			if (!record || record.deleted) {
				return null
			}
			const definition = schema.collections[collection]
			if (!definition) {
				return null
			}
			return toCollectionRecord(record, definition)
		},
	}
}

/**
 * Fold every record of the causal cut with the W7 fold, exactly as the live store
 * materializes it (the cut may hold concurrent branches: the fold, not the
 * application order, decides).
 */
function foldIntoMemory(ops: readonly Operation[], schema: SchemaDefinition): ReplayMemoryState {
	const byRecord = new Map<string, Operation[]>()
	for (const op of ops) {
		if (!schema.collections[op.collection]) continue
		const key = `${op.collection}\u0000${op.recordId}`
		const list = byRecord.get(key) ?? []
		list.push(op)
		byRecord.set(key, list)
	}
	const state: ReplayMemoryState = new Map()
	for (const recordOps of byRecord.values()) {
		const first = recordOps[0] as Operation
		const definition = schema.collections[first.collection] as CollectionDefinition
		const folded = foldRecord(recordOps, schema, { richtext: mergeYjsUpdates }).state
		if (folded === null || folded.cr === null || folded.u === null) continue
		const values = materialize({ ...folded, d: null }, { richtext: mergeYjsUpdates }) ?? {}
		let colMap = state.get(first.collection)
		if (!colMap) {
			colMap = new Map()
			state.set(first.collection, colMap)
		}
		colMap.set(first.recordId, {
			id: first.recordId,
			// The fold materializes op-data form (tagged binary); snapshots expose
			// record-shaped values (Uint8Array / string).
			fields: decodeRichtextFieldsFromOpData(values, definition.fields),
			deleted: !isFoldStateLive(folded),
			createdAt: HybridLogicalClock.deserialize(folded.cr.t).wallTime,
			updatedAt: HybridLogicalClock.deserialize(folded.u.t).wallTime,
		})
	}
	return state
}

function materializeCollections(
	schema: SchemaDefinition,
	memory: ReplayMemoryState,
): Record<string, CollectionRecord[]> {
	const collections: Record<string, CollectionRecord[]> = {}

	for (const [collectionName, definition] of Object.entries(schema.collections)) {
		const colMap = memory.get(collectionName)
		const records: CollectionRecord[] = []
		if (colMap) {
			for (const record of colMap.values()) {
				if (!record.deleted) {
					records.push(toCollectionRecord(record, definition))
				}
			}
		}
		collections[collectionName] = records
	}

	return collections
}

function toCollectionRecord(
	record: MutableReplayRecord,
	definition: CollectionDefinition,
): CollectionRecord {
	const result: CollectionRecord = {
		id: record.id,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	}
	for (const [fieldName] of Object.entries(definition.fields)) {
		if (fieldName in record.fields) {
			result[fieldName] = record.fields[fieldName]
		}
	}
	return result
}

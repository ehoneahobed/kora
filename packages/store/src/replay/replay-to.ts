import { OperationError } from '@korajs/core'
import type { CollectionDefinition, Operation, SchemaDefinition } from '@korajs/core'
import { topologicalSort } from '@korajs/core/internal'
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
 */
export function collectCausalClosure(allOps: Operation[], targetOperationId: string): Operation[] {
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
		for (const depId of op.causalDeps) {
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
): ReplaySnapshot {
	const operationsApplied = collectCausalClosure(allOps, targetOperationId)
	const targetOperation = operationsApplied.find((op) => op.id === targetOperationId)
	if (!targetOperation) {
		throw new OperationError(`Operation "${targetOperationId}" not found after causal sort`, {
			operationId: targetOperationId,
		})
	}

	const memory: ReplayMemoryState = new Map()
	for (const op of operationsApplied) {
		applyOperationToMemory(memory, op, schema)
	}

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

function applyOperationToMemory(
	state: ReplayMemoryState,
	op: Operation,
	schema: SchemaDefinition,
): void {
	const definition = schema.collections[op.collection]
	if (!definition) {
		return
	}

	let colMap = state.get(op.collection)
	if (!colMap) {
		colMap = new Map()
		state.set(op.collection, colMap)
	}

	const wallTime = op.timestamp.wallTime

	switch (op.type) {
		case 'insert': {
			if (!op.data) {
				return
			}
			colMap.set(op.recordId, {
				id: op.recordId,
				// op.data stores binary richtext as tagged JSON; snapshots must
				// expose record-shaped values (Uint8Array/string).
				fields: decodeRichtextFieldsFromOpData(op.data, definition.fields),
				deleted: false,
				createdAt: wallTime,
				updatedAt: wallTime,
			})
			break
		}
		case 'update': {
			if (!op.data) {
				return
			}
			const decodedData = decodeRichtextFieldsFromOpData(op.data, definition.fields)
			const existing = colMap.get(op.recordId)
			if (existing && !existing.deleted) {
				existing.fields = { ...existing.fields, ...decodedData }
				existing.updatedAt = wallTime
				break
			}
			if (existing?.deleted) {
				return
			}
			colMap.set(op.recordId, {
				id: op.recordId,
				fields: decodedData,
				deleted: false,
				createdAt: wallTime,
				updatedAt: wallTime,
			})
			break
		}
		case 'delete': {
			const existing = colMap.get(op.recordId)
			if (existing) {
				existing.deleted = true
				existing.updatedAt = wallTime
				return
			}
			colMap.set(op.recordId, {
				id: op.recordId,
				fields: {},
				deleted: true,
				createdAt: wallTime,
				updatedAt: wallTime,
			})
			break
		}
	}
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

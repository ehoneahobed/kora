import type {
	CollectionDefinition,
	HLCTimestamp,
	KoraEventEmitter,
	Operation,
	SchemaDefinition,
} from '@korajs/core'
import { HybridLogicalClock, KoraError, createOperation } from '@korajs/core'
import { topologicalSort } from '@korajs/core/internal'
import type { MergeEngine, MergeResult, ReferentialMergeContext, SideEffectOp } from '@korajs/merge'
import { buildMergeRelationLookup, checkReferentialIntegrityOnDelete } from '@korajs/merge'
import type { ConstraintContext } from '@korajs/merge'
import type {
	ApplyRemoteOptions,
	CollectionRecord,
	LocalMutationHandler,
	Store,
	TransactionCommitBatch,
	TransactionCommitResult,
} from '@korajs/store'
import { richtextStatesEqual } from '@korajs/store'
import {
	executeDelete,
	executeInsert,
	executeUpdate,
	resolveCausalDeps,
} from '@korajs/store/internal'
import type { ApplyResult } from '@korajs/sync'
import { buildSideEffectEntry } from './build-side-effect-entry'

/**
 * Whether the operation originated locally or arrived from sync.
 */
export type ApplyMode = 'local' | 'remote'

/**
 * Dependencies for the unified apply pipeline.
 */
export interface ApplyPipelineDeps {
	readonly store: Store
	readonly mergeEngine: MergeEngine
	readonly emitter: KoraEventEmitter | null
	/** Called when a field-level merge runs (updates sync conflict counter). */
	readonly onMergeConflict?: () => void
}

/**
 * Context passed into each apply invocation.
 */
export interface ApplyContext {
	readonly mode: ApplyMode
	readonly schema: SchemaDefinition
}

/**
 * Single entry point for applying remote sync operations with merge + referential integrity.
 */
export class ApplyPipeline implements LocalMutationHandler {
	private readonly relationLookupMap: ReturnType<typeof buildMergeRelationLookup>

	constructor(private readonly deps: ApplyPipelineDeps) {
		this.relationLookupMap = buildMergeRelationLookup(deps.store.getSchema())
	}

	/** Local insert — same persistence path as remote apply side effects. */
	async insert(collection: string, data: Record<string, unknown>): Promise<CollectionRecord> {
		return executeInsert(this.deps.store.createMutationContext(collection), data)
	}

	/** Local update. */
	async update(
		collection: string,
		id: string,
		data: Record<string, unknown>,
	): Promise<CollectionRecord> {
		return executeUpdate(this.deps.store.createMutationContext(collection), id, data)
	}

	/**
	 * Local delete with merge-package referential integrity (same rules as remote delete).
	 */
	async delete(collection: string, id: string): Promise<void> {
		const ctx = this.deps.store.createMutationContext(collection)
		const causalDeps = resolveCausalDeps(ctx)
		const operation = await createOperation(
			{
				nodeId: ctx.nodeId,
				type: 'delete',
				collection,
				recordId: id,
				data: null,
				previousData: null,
				sequenceNumber: await ctx.allocateSequenceNumber(),
				causalDeps,
				schemaVersion: ctx.schema.version,
			},
			ctx.clock,
		)
		ctx.causalTracker?.afterOperation(collection, operation.id, ctx.inTransaction)

		const refCtx = createReferentialMergeContext(this.deps.store)
		const check = await checkReferentialIntegrityOnDelete(
			operation,
			this.deps.store.getSchema(),
			refCtx,
			this.relationLookupMap,
		)

		for (const trace of check.traces) {
			this.deps.emitter?.emit({ type: 'merge:conflict', trace })
		}

		if (!check.allowed) {
			throw new KoraError(
				`Cannot delete record "${id}" from "${collection}": referential restrict policy violated`,
				'REFERENTIAL_INTEGRITY',
				{ collection, recordId: id },
			)
		}

		await executeDelete(ctx, id, {
			skipReferentialEnforcement: true,
			operation,
		})

		if (check.sideEffectOps.length > 0) {
			await applySideEffectOps(this.deps.store, check.sideEffectOps, operation.id)
		}
	}

	/**
	 * Commit a buffered transaction: merge-package delete enforcement, causal ordering, single DB txn.
	 */
	async commitTransaction(batch: TransactionCommitBatch): Promise<TransactionCommitResult> {
		const store = this.deps.store
		const supplemental: TransactionCommitBatch['entries'] = []

		for (const entry of batch.entries) {
			if (entry.operation.type !== 'delete') {
				continue
			}
			const refCtx = createReferentialMergeContext(store)
			const check = await checkReferentialIntegrityOnDelete(
				entry.operation,
				store.getSchema(),
				refCtx,
				this.relationLookupMap,
			)

			for (const trace of check.traces) {
				this.deps.emitter?.emit({ type: 'merge:conflict', trace })
			}

			if (!check.allowed) {
				throw new KoraError(
					`Cannot delete record "${entry.operation.recordId}" from "${entry.collection}": referential restrict policy violated`,
					'REFERENTIAL_INTEGRITY',
					{ collection: entry.collection, recordId: entry.operation.recordId },
				)
			}

			for (const effect of check.sideEffectOps) {
				const ctx = store.createMutationContext(effect.collection, { inTransaction: true })
				supplemental.push(
					await buildSideEffectEntry(
						ctx,
						effect,
						entry.operation.id,
						batch.transactionId,
						batch.mutationName,
					),
				)
			}
		}

		const allEntries = [...batch.entries, ...supplemental]
		const sortedOps = topologicalSort(allEntries.map((e) => e.operation))
		const commandsByOpId = new Map(allEntries.map((e) => [e.operation.id, e.commands] as const))

		const ctx = store.createMutationContext(
			batch.entries[0]?.collection ?? Object.keys(store.getSchema().collections)[0] ?? 'todos',
			{ inTransaction: true },
		)

		await ctx.adapter.transaction(async (tx) => {
			for (const op of sortedOps) {
				const commands = commandsByOpId.get(op.id)
				if (!commands) {
					continue
				}
				for (const cmd of commands) {
					await tx.execute(cmd.sql, cmd.params)
				}
			}
		})

		const affectedCollections = new Set<string>()
		for (const entry of allEntries) {
			affectedCollections.add(entry.collection)
		}

		return { operations: sortedOps, affectedCollections }
	}

	async applyRemote(op: Operation): Promise<ApplyResult> {
		return this.apply(op, { mode: 'remote', schema: this.deps.store.getSchema() })
	}

	async apply(op: Operation, context: ApplyContext): Promise<ApplyResult> {
		if (context.mode === 'local') {
			return this.deps.store.applyRemoteOperation(op)
		}

		if (op.type === 'delete') {
			return this.applyRemoteDelete(op)
		}

		if (op.type === 'insert' && op.data) {
			return this.applyRemoteInsert(op)
		}

		if (op.type === 'update' && op.data && op.previousData) {
			return this.applyRemoteUpdate(op)
		}

		return this.deps.store.applyRemoteOperation(op)
	}

	private async applyRemoteDelete(op: Operation): Promise<ApplyResult> {
		const blocked = await this.resolveRemoteDeleteVsLocalUpdate(op)
		if (blocked) {
			return 'skipped'
		}

		const refCtx = createReferentialMergeContext(this.deps.store)
		const check = await checkReferentialIntegrityOnDelete(
			op,
			this.deps.store.getSchema(),
			refCtx,
			this.relationLookupMap,
		)

		for (const trace of check.traces) {
			this.deps.emitter?.emit({ type: 'merge:conflict', trace })
		}

		if (!check.allowed) {
			return 'rejected'
		}

		const result = await this.deps.store.applyRemoteOperation(op)
		if (result !== 'applied') {
			return result
		}

		if (check.sideEffectOps.length > 0) {
			await applySideEffectOps(this.deps.store, check.sideEffectOps, op.id)
		}

		return 'applied'
	}

	/**
	 * When a local update is newer than a remote delete, keep the record alive.
	 */
	private async resolveRemoteDeleteVsLocalUpdate(op: Operation): Promise<boolean> {
		const collectionDef = this.deps.store.getSchema().collections[op.collection]
		if (!collectionDef) {
			return false
		}

		const localOp = await this.deps.store.getLatestLocalOperationForRecord(
			op.collection,
			op.recordId,
		)
		if (!localOp || localOp.type !== 'update') {
			return false
		}

		const baseState = localOp.previousData ?? {}
		const mergeResult = await this.deps.mergeEngine.merge({
			local: localOp,
			remote: op,
			baseState,
			collectionDef,
		})

		this.emitMergeLifecycle(op, localOp, mergeResult)

		return mergeResult.appliedOperation === 'local'
	}

	private async applyRemoteUpdate(op: Operation): Promise<ApplyResult> {
		const schema = this.deps.store.getSchema()
		const collectionDef = schema.collections[op.collection]
		if (!collectionDef) {
			return this.deps.store.applyRemoteOperation(op)
		}

		const accessor = this.deps.store.collection(op.collection)
		const currentRecord = await accessor.findById(op.recordId)

		if (!currentRecord) {
			const tombstoneResult = await this.applyRemoteUpdateOnDeletedRow(op, collectionDef)
			if (tombstoneResult !== null) {
				return tombstoneResult
			}
			return this.deps.store.applyRemoteOperation(op)
		}

		let hasConflict = false
		for (const field of Object.keys(op.data ?? {})) {
			const fieldDef = collectionDef.fields[field]
			const expectedBase = op.previousData?.[field]
			const currentLocal = currentRecord[field]

			if (fieldDef?.kind === 'richtext') {
				if (!richtextStatesEqual(currentLocal, expectedBase)) {
					hasConflict = true
				}
				continue
			}

			if (!deepEqual(expectedBase, currentLocal)) {
				hasConflict = true
				break
			}
		}

		if (!hasConflict) {
			return this.deps.store.applyRemoteOperation(op)
		}

		return this.applyMergedUpdate(op, collectionDef, currentRecord, op.previousData ?? {})
	}

	/**
	 * Remote update vs local soft-delete: merge before materializing to avoid zombie rows.
	 */
	private async applyRemoteUpdateOnDeletedRow(
		op: Operation,
		collectionDef: CollectionDefinition,
	): Promise<ApplyResult | null> {
		const snapshot = await this.deps.store.findMaterializedRow(op.collection, op.recordId)
		if (!snapshot?.deleted) {
			return null
		}

		const localOp = await this.deps.store.getLatestLocalOperationForRecord(
			op.collection,
			op.recordId,
		)
		if (!localOp || localOp.type !== 'delete') {
			return null
		}

		const mergeResult = await this.deps.mergeEngine.merge({
			local: localOp,
			remote: op,
			baseState: op.previousData ?? {},
			collectionDef,
		})

		this.emitMergeLifecycle(op, localOp, mergeResult)

		if (mergeResult.appliedOperation === 'local') {
			return 'skipped'
		}

		const mergedOp: Operation = {
			...op,
			data: { ...mergeResult.mergedData },
			timestamp: maxTimestamp(op.timestamp, localOp.timestamp),
		}

		const applyResult = await this.deps.store.applyRemoteOperation(mergedOp, {
			reactivateIfDeleted: true,
		})

		if (applyResult === 'applied' && mergeResult.sideEffects.length > 0) {
			await applySideEffectOps(this.deps.store, mergeResult.sideEffects, op.id)
		}

		return applyResult
	}

	private async applyMergedUpdate(
		op: Operation,
		collectionDef: CollectionDefinition,
		currentRecord: CollectionRecord,
		baseState: Record<string, unknown>,
		applyOptions?: ApplyRemoteOptions,
	): Promise<ApplyResult> {
		const localTimestamp = await resolveLocalTimestamp(
			this.deps.store,
			op.collection,
			op.recordId,
			currentRecord,
			this.deps.store.getNodeId(),
		)
		const localOp: Operation = {
			...op,
			data: buildLocalDiff(baseState, currentRecord, Object.keys(op.data ?? {})),
			previousData: op.previousData,
			nodeId: this.deps.store.getNodeId(),
			timestamp: localTimestamp,
		}

		const constraintContext = createConstraintContext(this.deps.store)
		const mergeResult = await this.deps.mergeEngine.merge(
			{
				local: localOp,
				remote: op,
				baseState,
				collectionDef,
			},
			constraintContext,
		)

		this.emitMergeLifecycle(op, localOp, mergeResult)

		const mergedOp: Operation = {
			...op,
			data: mergeResult.mergedData,
			timestamp: maxTimestamp(op.timestamp, localTimestamp),
		}

		const applyResult = await this.deps.store.applyRemoteOperation(mergedOp, applyOptions)

		if (applyResult === 'applied' && mergeResult.sideEffects.length > 0) {
			await applySideEffectOps(this.deps.store, mergeResult.sideEffects, op.id)
		}

		return applyResult
	}

	private async applyRemoteInsert(op: Operation): Promise<ApplyResult> {
		const collectionDef = this.deps.store.getSchema().collections[op.collection]
		if (!collectionDef || !op.data) {
			return this.deps.store.applyRemoteOperation(op)
		}

		const snapshot = await this.deps.store.findMaterializedRow(op.collection, op.recordId)
		if (!snapshot || snapshot.deleted) {
			return this.deps.store.applyRemoteOperation(op)
		}

		const localOp = await resolveLocalOpForRecord(
			this.deps.store,
			op.collection,
			op.recordId,
			snapshot.record,
		)

		const mergeResult = await this.deps.mergeEngine.merge({
			local: localOp,
			remote: op,
			baseState: {},
			collectionDef,
		})

		this.emitMergeLifecycle(op, localOp, mergeResult)

		const mergedOp: Operation = {
			...op,
			data: mergeResult.mergedData,
			timestamp: maxTimestamp(op.timestamp, localOp.timestamp),
		}

		return this.deps.store.applyRemoteOperation(mergedOp)
	}

	private emitMergeLifecycle(remote: Operation, local: Operation, mergeResult: MergeResult): void {
		this.deps.emitter?.emit({
			type: 'merge:started',
			operationA: remote,
			operationB: local,
		})

		const hadMergeConflict = mergeResult.traces.some(
			(t) =>
				t.strategy !== 'no-conflict-local' &&
				t.strategy !== 'no-conflict-remote' &&
				t.strategy !== 'no-conflict-unchanged',
		)
		if (hadMergeConflict) {
			this.deps.onMergeConflict?.()
		}

		for (const trace of mergeResult.traces) {
			if (
				trace.strategy !== 'no-conflict-local' &&
				trace.strategy !== 'no-conflict-remote' &&
				trace.strategy !== 'no-conflict-unchanged'
			) {
				this.deps.emitter?.emit({ type: 'merge:conflict', trace })
			}
		}
		const firstTrace = mergeResult.traces[0]
		if (firstTrace) {
			this.deps.emitter?.emit({ type: 'merge:completed', trace: firstTrace })
		}
	}
}

/**
 * Prefer the latest local op, then any op in the log for this record, then a snapshot-derived insert.
 */
async function resolveLocalOpForRecord(
	store: Store,
	collection: string,
	recordId: string,
	record: CollectionRecord,
): Promise<Operation> {
	const localLatest = await store.getLatestLocalOperationForRecord(collection, recordId)
	if (localLatest) {
		return localLatest
	}

	const anyLatest = await store.getLatestOperationForRecord(collection, recordId)
	if (anyLatest) {
		return anyLatest
	}

	return syntheticInsertFromSnapshot(
		record,
		collection,
		store.getNodeId(),
		store.getSchema().version,
	)
}

function syntheticInsertFromSnapshot(
	record: CollectionRecord,
	collection: string,
	nodeId: string,
	schemaVersion: number,
): Operation {
	const { id, createdAt, updatedAt, ...fields } = record
	return {
		id: `synthetic-local-${id}`,
		nodeId,
		type: 'insert',
		collection,
		recordId: id,
		data: fields,
		previousData: null,
		timestamp: { wallTime: updatedAt, logical: 0, nodeId },
		sequenceNumber: 0,
		causalDeps: [],
		schemaVersion,
	}
}

function createConstraintContext(store: Store): ConstraintContext {
	return {
		async queryRecords(collection: string, where: Record<string, unknown>) {
			const rows = await store.collection(collection).where(where).exec()
			return rows as Record<string, unknown>[]
		},
		async countRecords(collection: string, where: Record<string, unknown>) {
			return store.collection(collection).where(where).count()
		},
	}
}

function createReferentialMergeContext(store: Store): ReferentialMergeContext {
	return {
		async queryRecords(collection: string, where: Record<string, unknown>) {
			const rows = await store.collection(collection).where(where).exec()
			return rows as Record<string, unknown>[]
		},
		async recordExists(collection: string, recordId: string) {
			const row = await store.collection(collection).findById(recordId)
			return row !== null
		},
	}
}

async function applySideEffectOps(
	store: Store,
	sideEffects: SideEffectOp[],
	parentOpId: string,
): Promise<void> {
	for (const effect of sideEffects) {
		const ctx = store.createMutationContext(effect.collection, {
			extraCausalDeps: [parentOpId],
		})
		if (effect.type === 'delete') {
			await executeDelete(ctx, effect.recordId, { skipReferentialEnforcement: true })
		} else if (effect.type === 'update' && effect.data) {
			await executeUpdate(ctx, effect.recordId, effect.data)
		}
	}
}

function buildLocalDiff(
	baseState: Record<string, unknown>,
	currentRecord: Record<string, unknown>,
	fields: string[],
): Record<string, unknown> {
	const diff: Record<string, unknown> = {}
	for (const field of fields) {
		diff[field] = currentRecord[field]
	}
	return diff
}

async function resolveLocalTimestamp(
	store: Store,
	collection: string,
	recordId: string,
	currentRecord: CollectionRecord,
	nodeId: string,
): Promise<HLCTimestamp> {
	const latestLocal = await store.getLatestLocalOperationForRecord(collection, recordId)
	if (latestLocal) {
		return latestLocal.timestamp
	}
	const updatedAt = currentRecord.updatedAt
	if (typeof updatedAt === 'number') {
		return { wallTime: updatedAt, logical: 0, nodeId }
	}
	return { wallTime: Date.now(), logical: 0, nodeId }
}

function maxTimestamp(a: HLCTimestamp, b: HLCTimestamp): HLCTimestamp {
	return HybridLogicalClock.compare(a, b) >= 0 ? a : b
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true
	if (a === null || b === null) return false
	if (a === undefined || b === undefined) return false
	if (typeof a !== typeof b) return false

	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false
		return a.every((val, i) => deepEqual(val, b[i]))
	}

	if (typeof a === 'object' && typeof b === 'object') {
		const keysA = Object.keys(a as Record<string, unknown>)
		const keysB = Object.keys(b as Record<string, unknown>)
		if (keysA.length !== keysB.length) return false
		return keysA.every((key) =>
			deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
		)
	}

	return false
}

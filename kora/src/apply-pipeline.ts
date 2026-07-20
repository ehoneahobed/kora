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
	RowVersionState,
	Store,
	TransactionCommitBatch,
	TransactionCommitResult,
} from '@korajs/store'
import { OptimisticLockError, richtextStatesEqual } from '@korajs/store'
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
 * How many times a merge-engine apply retries when the row changed underneath
 * it (OptimisticLockError). Each retry recomputes the merge from fresh state;
 * since JavaScript is single-threaded, invalidation requires an actual new
 * local write landing at an `await` point, so contention is self-limiting.
 * Exhaustion rethrows: the operation stays unacknowledged and sync retries it
 * later — data is never dropped.
 */
const MERGE_APPLY_RETRY_LIMIT = 8

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

		// Merge-engine paths read state, compute a merge, then write. A concurrent
		// local mutation landing between read and write invalidates the merge; the
		// guarded apply detects this (OptimisticLockError) and we recompute from
		// fresh state. Bounded so a pathological writer can't spin forever —
		// exhaustion rethrows, leaving the op unacknowledged for a later sync
		// retry (never silently dropped).
		let lockError: OptimisticLockError | null = null
		for (let attempt = 0; attempt < MERGE_APPLY_RETRY_LIMIT; attempt++) {
			try {
				return await this.applyRemoteUpdateAttempt(op, collectionDef)
			} catch (error) {
				if (!(error instanceof OptimisticLockError)) {
					throw error
				}
				lockError = error
			}
		}
		throw lockError ?? new OptimisticLockError(op.collection, op.recordId)
	}

	private async applyRemoteUpdateAttempt(
		op: Operation,
		collectionDef: CollectionDefinition,
	): Promise<ApplyResult> {
		// Snapshot the row's version state BEFORE reading the record: if a local
		// write lands between these two reads, the guard is older than the record
		// and the guarded apply fails safe (retry). The reverse order would let a
		// merge computed from a stale record pass a fresh guard and clobber the
		// local write.
		const guard: RowVersionState = (await this.deps.store.getRowVersionState(
			op.collection,
			op.recordId,
		)) ?? { version: null, fieldVersions: null }

		const accessor = this.deps.store.collection(op.collection)
		const currentRecord = await accessor.findById(op.recordId)

		if (!currentRecord) {
			const tombstoneResult = await this.applyRemoteUpdateOnDeletedRow(op, collectionDef, guard)
			if (tombstoneResult !== null) {
				return tombstoneResult
			}
			// No materialized row at all: the store's atomic path appends the op
			// (nothing to guard — materialization is a no-op until the insert lands).
			return this.deps.store.applyRemoteOperation(op)
		}

		// Pure scalar last-write-wins is resolved deterministically and atomically
		// inside the store using per-field HLC versions. Routing it there (instead
		// of pre-reading the row here to guess a conflict) both removes the
		// read-decide-write race — a concurrent local edit can no longer slip
		// between the check and the write — and guarantees every node converges to
		// the max-timestamp writer regardless of the order operations arrive. Only
		// CRDT fields (richtext, add-wins-set arrays), declared constraints, or
		// custom resolvers still need the three-tier merge engine.
		if (!updateNeedsMergeEngine(op, collectionDef)) {
			// The store resolves the write deterministically, but a same-field
			// concurrent edit is still a merge decision the developer/DevTools must
			// see. Emit the trace from the immutable local op in the log (race-free),
			// then let the store perform the authoritative atomic write.
			await this.observeScalarMerge(op, collectionDef)
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
			// No CRDT/constraint field the remote op touches has diverged locally
			// from the base it wrote from: a clean fast-forward. Guarded, because
			// the divergence check above read the row outside the write transaction.
			return this.deps.store.applyRemoteOperation(op, {
				forceMaterialize: true,
				guardRowState: guard,
			})
		}

		return this.applyMergedUpdate(op, collectionDef, currentRecord, op.previousData ?? {}, guard)
	}

	/**
	 * Remote update vs local soft-delete: merge before materializing to avoid zombie rows.
	 */
	/**
	 * Emit merge observability (trace + conflict counter) for a scalar update that
	 * concurrently touches a field a local operation also changed.
	 *
	 * The store resolves the actual value by deterministic per-field LWW; this
	 * method exists only so the decision is loggable (CLAUDE.md: every merge
	 * decision must be traceable). It reads the local operation from the append-
	 * only log — which is immutable — rather than the materialized row, so it is
	 * not subject to the read-then-write race the store write path was hardened
	 * against. The merge engine is invoked purely to build an accurate trace; its
	 * timestamps match the store's LWW comparison, so the trace never lies.
	 */
	private async observeScalarMerge(
		op: Operation,
		collectionDef: CollectionDefinition,
	): Promise<void> {
		const localOp = await this.deps.store.getLatestLocalOperationForRecord(
			op.collection,
			op.recordId,
		)
		if (!localOp || !localOp.data) {
			return
		}
		const remoteFields = Object.keys(op.data ?? {})
		const sharesField = remoteFields.some((field) => localOp.data?.[field] !== undefined)
		if (!sharesField) {
			return
		}

		const mergeResult = await this.deps.mergeEngine.merge({
			local: localOp,
			remote: op,
			baseState: op.previousData ?? {},
			collectionDef,
		})
		this.emitMergeLifecycle(op, localOp, mergeResult)
	}

	private async applyRemoteUpdateOnDeletedRow(
		op: Operation,
		collectionDef: CollectionDefinition,
		guard: RowVersionState,
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

		if (mergeResult.appliedOperation === 'local') {
			this.emitMergeLifecycle(op, localOp, mergeResult)
			return 'skipped'
		}

		// The log keeps the canonical op; only the ROW materializes the merged
		// data at max(local, remote). Guarded: a local write between our snapshot
		// read and this apply invalidates the merge and triggers a retry.
		const applyResult = await this.deps.store.applyRemoteOperation(op, {
			reactivateIfDeleted: true,
			forceMaterialize: true,
			materializeData: { ...mergeResult.mergedData },
			materializeTimestamp: maxTimestamp(op.timestamp, localOp.timestamp),
			guardRowState: guard,
		})

		this.emitMergeLifecycle(op, localOp, mergeResult)

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
		guard: RowVersionState,
		applyOptions?: ApplyRemoteOptions,
	): Promise<ApplyResult> {
		const latestLocal = await this.deps.store.getLatestLocalOperationForRecord(
			op.collection,
			op.recordId,
		)
		const localTimestamp = resolveLocalTimestamp(
			latestLocal,
			currentRecord,
			this.deps.store.getNodeId(),
		)
		// The spread of `op` would copy the REMOTE op's atomicOps onto the local
		// side, making atomic composition double the remote delta instead of
		// summing both intents. The local side's intent metadata must come from
		// the actual local operation — or be absent entirely.
		const { atomicOps: _remoteAtomicOps, ...opWithoutAtomic } = op
		const localOp: Operation = {
			...opWithoutAtomic,
			data: buildLocalDiff(baseState, currentRecord, Object.keys(op.data ?? {})),
			previousData: op.previousData,
			nodeId: this.deps.store.getNodeId(),
			timestamp: localTimestamp,
			...(latestLocal?.atomicOps !== undefined ? { atomicOps: latestLocal.atomicOps } : {}),
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

		// The merged data is authoritative (it already folds in the current local
		// row), so it must materialize even when its timestamp ties the current
		// row version — otherwise the device that authored the newer of two
		// concurrent edits silently drops the merge result and never converges.
		// The LOG stores the canonical op (ops are immutable, content-addressed);
		// only the row write uses the merged data and max(local, remote) stamp.
		// Guarded: a local write since our snapshot invalidates the merge.
		const applyResult = await this.deps.store.applyRemoteOperation(op, {
			...applyOptions,
			forceMaterialize: true,
			materializeData: mergeResult.mergedData,
			materializeTimestamp: maxTimestamp(op.timestamp, localTimestamp),
			guardRowState: guard,
		})

		// Emit AFTER the guarded apply so a retried attempt doesn't double-report
		// a merge decision that never materialized.
		this.emitMergeLifecycle(op, localOp, mergeResult)

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

		let lockError: OptimisticLockError | null = null
		for (let attempt = 0; attempt < MERGE_APPLY_RETRY_LIMIT; attempt++) {
			try {
				return await this.applyRemoteInsertAttempt(op, collectionDef)
			} catch (error) {
				if (!(error instanceof OptimisticLockError)) {
					throw error
				}
				lockError = error
			}
		}
		throw lockError ?? new OptimisticLockError(op.collection, op.recordId)
	}

	private async applyRemoteInsertAttempt(
		op: Operation,
		collectionDef: CollectionDefinition,
	): Promise<ApplyResult> {
		// Guard snapshot BEFORE the record read (see applyRemoteUpdateAttempt).
		const guard: RowVersionState = (await this.deps.store.getRowVersionState(
			op.collection,
			op.recordId,
		)) ?? { version: null, fieldVersions: null }

		const snapshot = await this.deps.store.findMaterializedRow(op.collection, op.recordId)
		if (!snapshot || snapshot.deleted) {
			// Absent row and insert-vs-tombstone are resolved atomically inside the
			// store; guard against a local write racing this decision.
			return this.deps.store.applyRemoteOperation(op, { guardRowState: guard })
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

		// Canonical op in the log; merged data + max(local, remote) stamp on the
		// row. Force, because the merged result folds in the current local row and
		// must win even on a version tie with it.
		const applyResult = await this.deps.store.applyRemoteOperation(op, {
			forceMaterialize: true,
			materializeData: mergeResult.mergedData,
			materializeTimestamp: maxTimestamp(op.timestamp, localOp.timestamp),
			guardRowState: guard,
		})

		this.emitMergeLifecycle(op, localOp, mergeResult)

		return applyResult
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

/**
 * Whether applying this remote update requires the three-tier merge engine.
 *
 * Scalar fields converge under deterministic per-field LWW handled entirely in
 * the store. The merge engine is only needed when a changed field is a CRDT
 * (richtext or add-wins-set array), when the collection declares constraints, or
 * when a changed field has a custom resolver.
 */
function updateNeedsMergeEngine(op: Operation, collectionDef: CollectionDefinition): boolean {
	if (collectionDef.constraints.length > 0) {
		return true
	}
	// Intent-preserving atomic ops (increment/max/min) COMPOSE with a concurrent
	// local atomic op instead of last-write-wins — plain per-field LWW would
	// silently drop one side's delta (a lost update).
	if (op.atomicOps && Object.keys(op.atomicOps).length > 0) {
		return true
	}
	for (const field of Object.keys(op.data ?? {})) {
		const kind = collectionDef.fields[field]?.kind
		if (kind === 'richtext' || kind === 'array') {
			return true
		}
		if (collectionDef.resolvers[field]) {
			return true
		}
	}
	return false
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

function resolveLocalTimestamp(
	latestLocal: Operation | null,
	currentRecord: CollectionRecord,
	nodeId: string,
): HLCTimestamp {
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

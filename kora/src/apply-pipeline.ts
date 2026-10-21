import type { KoraEventEmitter, MergeTrace, Operation, SchemaDefinition } from '@korajs/core'
import { KoraError, quoteIdent } from '@korajs/core'
import type { MergeEngine, ReferentialMergeContext } from '@korajs/merge'
import {
	buildMergeRelationLookup,
	checkConstraints,
	checkReferentialIntegrityOnDelete,
} from '@korajs/merge'
import type {
	CollectionRecord,
	LocalMutationHandler,
	RemoteApplyBatch,
	RemoteBatchCollectionReader,
	Store,
	Transaction,
} from '@korajs/store'
import {
	deserializeRecord,
	executeDelete,
	executeInsert,
	executeInsertMany,
	executeUpdate,
} from '@korajs/store/internal'
import type { RawCollectionRow } from '@korajs/store/internal'
import type { ApplyResult } from '@korajs/sync'
import { LegacyApplyPipeline } from './legacy-apply-pipeline'

/**
 * Whether the operation originated locally or arrived from sync.
 */
export type ApplyMode = 'local' | 'remote'

/**
 * Context passed into each apply invocation.
 */
export interface ApplyContext {
	readonly mode: ApplyMode
	readonly schema: SchemaDefinition
}

/**
 * Dependencies for the apply pipeline.
 */
export interface ApplyPipelineDeps {
	readonly store: Store
	readonly emitter: KoraEventEmitter | null
	/** Called when a merge had a conflicting field decision (sync conflict counter). */
	readonly onMergeConflict?: () => void
	/**
	 * The beta.12 pairwise merge engine. Used only when the store runs the legacy
	 * materialization (`experimental.legacyMerge`, one beta).
	 */
	readonly mergeEngine?: MergeEngine
}

/**
 * Applies operations to the local store (W7): "append, then merge". The store
 * appends each operation to the log and merges it into its record's per-field
 * CRDT fold state, which re-materializes the row, in one write transaction; the
 * result is independent of arrival order. Local writes go through the same fold
 * (the single local write path stays the sequencing authority).
 *
 * The pipeline adds what involves OTHER records:
 * - referential integrity for deletes (restrict / cascade / set-null);
 * - an optimistic check of cross-record (tier 2) constraints after a remote
 *   operation, reported as `constraint:violated`; the server is the authority and
 *   its corrections arrive as ordinary operations.
 */
export class ApplyPipeline implements LocalMutationHandler {
	private readonly relationLookupMap: ReturnType<typeof buildMergeRelationLookup>
	private legacy: LegacyApplyPipeline | null = null

	constructor(private readonly deps: ApplyPipelineDeps) {
		this.relationLookupMap = buildMergeRelationLookup(deps.store.getSchema())
	}

	/** Local insert — the single local write path. */
	async insert(collection: string, data: Record<string, unknown>): Promise<CollectionRecord> {
		return executeInsert(this.deps.store.createMutationContext(collection), data)
	}

	/** Local bulk insert: one write transaction, all or none, one operation per record. */
	async insertMany(
		collection: string,
		rows: readonly Record<string, unknown>[],
	): Promise<CollectionRecord[]> {
		return executeInsertMany(this.deps.store.createMutationContext(collection), rows)
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
	 * Local delete. The store builds and persists the delete, its referential
	 * side effects (cascade / set-null, recursively) and their sequence numbers in
	 * one write transaction; {@link beforeLocalDelete} adds the merge-package
	 * referential checks and their DevTools traces inside that transaction.
	 */
	async delete(collection: string, id: string): Promise<void> {
		await executeDelete(this.deps.store.createMutationContext(collection), id)
	}

	/**
	 * Referential integrity for a local delete, run inside the delete's write
	 * transaction: emits the referential merge traces and refuses a delete a
	 * `restrict` relation forbids.
	 */
	async beforeLocalDelete(operation: Operation, tx: Transaction): Promise<void> {
		const schema = this.deps.store.getSchema()
		const check = await checkReferentialIntegrityOnDelete(
			operation,
			schema,
			createTransactionalReferentialContext(schema, tx),
			this.relationLookupMap,
		)

		for (const trace of check.traces) {
			this.deps.emitter?.emit({ type: 'merge:conflict', trace })
		}

		if (!check.allowed) {
			throw new KoraError(
				`Cannot delete record "${operation.recordId}" from "${operation.collection}": referential restrict policy violated`,
				'REFERENTIAL_INTEGRITY',
				{ collection: operation.collection, recordId: operation.recordId },
			)
		}
	}

	async applyRemote(op: Operation): Promise<ApplyResult> {
		return this.apply(op, { mode: 'remote', schema: this.deps.store.getSchema() })
	}

	async apply(op: Operation, context: ApplyContext): Promise<ApplyResult> {
		if (!this.deps.store.isFoldMaterialized()) {
			return this.legacyPipeline().apply(op, context)
		}
		if (context.mode === 'local') {
			return this.deps.store.applyRemoteOperation(op)
		}
		if (op.type === 'delete') {
			return this.applyRemoteDelete(op)
		}
		const result = await this.applyFolded(op)
		if (result === 'applied') {
			const report = await this.checkConstraintsOptimistically(op, (collection) =>
				this.deps.store.collection(collection),
			)
			report?.()
		}
		return result
	}

	private applyFolded(op: Operation): Promise<ApplyResult> {
		return this.deps.store.applyRemoteOperation(op, {
			onMergeTraces: (traces: MergeTrace[]) => {
				if (traces.length > 0) this.deps.onMergeConflict?.()
			},
		})
	}

	/**
	 * {@link applyRemote} inside a delivery batch applied in one storage transaction (C3):
	 * the same decisions, with every read and write through the batch's transaction and
	 * every report (merge traces, the optimistic constraint check) after its commit.
	 * Requires the fold materialization (the store refuses to batch otherwise).
	 *
	 * @param position - The operation's delivery position, when known
	 */
	async applyRemoteInBatch(
		op: Operation,
		batch: RemoteApplyBatch,
		position: number | undefined,
	): Promise<ApplyResult> {
		const options = {
			...(position !== undefined ? { deliveryPosition: position } : {}),
			onMergeTraces: (traces: MergeTrace[]) => {
				if (traces.length > 0) this.deps.onMergeConflict?.()
			},
		}
		if (op.type !== 'delete') {
			const result = await batch.applyRemoteOperation(op, options)
			if (result === 'applied') {
				// Checked now, against the state right after this operation (the batch's own
				// writes so far, through its transaction), exactly as the per-operation path
				// checks after each commit; reported after the batch commits. A failing check
				// stalls the batch like it stalls a per-operation apply.
				const report = await this.checkConstraintsOptimistically(op, (collection) =>
					batch.read(collection),
				)
				if (report) batch.afterCommit(report)
			}
			return result
		}
		const schema = this.deps.store.getSchema()
		const check = await checkReferentialIntegrityOnDelete(
			op,
			schema,
			createTransactionalReferentialContext(schema, batch.tx),
			this.relationLookupMap,
		)
		const emitter = this.deps.emitter
		if (emitter && check.traces.length > 0) {
			const traces = check.traces
			batch.afterCommit(() => {
				for (const trace of traces) emitter.emit({ type: 'merge:conflict', trace })
			})
		}
		if (!check.allowed) {
			return 'rejected'
		}
		const result = await batch.applyRemoteOperation(op, options)
		if (result !== 'applied' || check.sideEffectOps.length === 0) {
			return result
		}
		// A newer local write keeps the record alive: then nothing cascades.
		const row = await batch.findMaterializedRow(op.collection, op.recordId)
		if (row && !row.deleted) {
			return result
		}
		// RT-69: provisional, local-only cascades (see applyRemoteDelete).
		await batch.applyProvisionalSideEffects(
			op,
			check.sideEffectOps.map((effect) => ({
				type: effect.type,
				collection: effect.collection,
				recordId: effect.recordId,
				data: effect.data,
				previousData: effect.previousData,
				ruleId: `relation:${effect.relationName}:${effect.type === 'delete' ? 'cascade' : 'set-null'}`,
			})),
		)
		return result
	}

	/**
	 * A remote delete: refused when a `restrict` relation forbids it; otherwise
	 * merged (record-level last-write-wins against the record's newest write), and
	 * its cascades / set-nulls run only when the record is actually deleted.
	 */
	private async applyRemoteDelete(op: Operation): Promise<ApplyResult> {
		const check = await checkReferentialIntegrityOnDelete(
			op,
			this.deps.store.getSchema(),
			createReferentialMergeContext(this.deps.store),
			this.relationLookupMap,
		)
		for (const trace of check.traces) {
			this.deps.emitter?.emit({ type: 'merge:conflict', trace })
		}
		if (!check.allowed) {
			return 'rejected'
		}
		const result = await this.applyFolded(op)
		if (result !== 'applied' || check.sideEffectOps.length === 0) {
			return result
		}
		// A newer local write keeps the record alive: then nothing cascades.
		const row = await this.deps.store.findMaterializedRow(op.collection, op.recordId)
		if (row && !row.deleted) {
			return result
		}
		// RT-69: the cascades of a REMOTE delete stay local. The author uploaded its own
		// copies and the server derives its own; a copy authored here would be stored and
		// relayed once per receiving device. They are folded as provisional effects (never
		// logged, sequenced or queued) until the server's copy arrives.
		await this.deps.store.applyProvisionalSideEffects(
			op,
			check.sideEffectOps.map((effect) => ({
				type: effect.type,
				collection: effect.collection,
				recordId: effect.recordId,
				data: effect.data,
				previousData: effect.previousData,
				ruleId: `relation:${effect.relationName}:${effect.type === 'delete' ? 'cascade' : 'set-null'}`,
			})),
		)
		return result
	}

	/**
	 * Tier 2 constraints that span records (unique, capacity, referential) are
	 * evaluated optimistically here and authoritatively on the server: a violation
	 * is reported (`constraint:violated`) but not resolved locally, so every
	 * replica keeps folding the same operations and the server's correction, an
	 * ordinary operation, converges them.
	 *
	 * The check reads through `read` the state right after `op` (the store, or a delivery
	 * batch's transaction with its writes so far), so each operation's report describes
	 * that operation, never a later write of the same batch. It returns the report to run
	 * (after the batch commits, for a batch), or null when there is nothing to report; a
	 * failing check rejects, which stalls the operation on both paths.
	 */
	private async checkConstraintsOptimistically(
		op: Operation,
		read: (collection: string) => RemoteBatchCollectionReader,
	): Promise<(() => void) | null> {
		const emitter = this.deps.emitter
		const definition = this.deps.store.getSchema().collections[op.collection]
		if (!emitter || !definition || definition.constraints.length === 0) return null
		const record = await read(op.collection).findById(op.recordId)
		if (!record) return null
		const violations = await checkConstraints(
			record as Record<string, unknown>,
			op.recordId,
			op.collection,
			definition,
			{
				queryRecords: async (collection, where) =>
					(await read(collection).where(where).exec()) as Record<string, unknown>[],
				countRecords: (collection, where) => read(collection).where(where).count(),
			},
		)
		if (violations.length === 0) return null
		return () => {
			for (const violation of violations) {
				const field = violation.fields.join(',')
				emitter.emit({
					type: 'constraint:violated',
					constraint: violation.message,
					trace: {
						operationA: op,
						operationB: op,
						field,
						strategy: `optimistic-${violation.constraint.type}`,
						inputA: record[violation.fields[0] ?? ''] ?? null,
						inputB: record[violation.fields[0] ?? ''] ?? null,
						base: null,
						output: record[violation.fields[0] ?? ''] ?? null,
						tier: 2,
						constraintViolated: violation.message,
						duration: 0,
					},
				})
			}
		}
	}

	private legacyPipeline(): LegacyApplyPipeline {
		if (this.legacy === null) {
			if (!this.deps.mergeEngine) {
				throw new KoraError(
					'The store uses the legacy materialization but no merge engine was given to the apply pipeline.',
					'LEGACY_MERGE_ENGINE_MISSING',
					{ fix: 'Pass mergeEngine (experimental.legacyMerge) or use the default fold.' },
				)
			}
			this.legacy = new LegacyApplyPipeline({
				store: this.deps.store,
				mergeEngine: this.deps.mergeEngine,
				emitter: this.deps.emitter,
				...(this.deps.onMergeConflict ? { onMergeConflict: this.deps.onMergeConflict } : {}),
			})
		}
		return this.legacy
	}
}

/**
 * Referential lookups for a local delete, read through the delete's own write
 * transaction so they see exactly the rows the transaction commits against.
 */
function createTransactionalReferentialContext(
	schema: SchemaDefinition,
	tx: Transaction,
): ReferentialMergeContext {
	return {
		async queryRecords(collection: string, where: Record<string, unknown>) {
			const definition = schema.collections[collection]
			if (!definition) return []
			const fields = Object.keys(where)
			const clause = fields.map((field) => `${quoteIdent(field)} = ?`).join(' AND ')
			const rows = await tx.query<RawCollectionRow>(
				`SELECT * FROM ${quoteIdent(collection)} WHERE _deleted = 0${clause ? ` AND ${clause}` : ''}`,
				fields.map((field) => where[field]),
			)
			return rows.map((row) => deserializeRecord(row, definition.fields) as Record<string, unknown>)
		},
		async recordExists(collection: string, recordId: string) {
			const rows = await tx.query<{ id: string }>(
				`SELECT id FROM ${quoteIdent(collection)} WHERE id = ? AND _deleted = 0`,
				[recordId],
			)
			return rows.length > 0
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

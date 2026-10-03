import type { KoraEventEmitter, MergeTrace, Operation, SchemaDefinition } from '@korajs/core'
import { KoraError, quoteIdent } from '@korajs/core'
import type { MergeEngine, ReferentialMergeContext } from '@korajs/merge'
import {
	buildMergeRelationLookup,
	checkConstraints,
	checkReferentialIntegrityOnDelete,
} from '@korajs/merge'
import type { CollectionRecord, LocalMutationHandler, Store, Transaction } from '@korajs/store'
import {
	deserializeRecord,
	executeDelete,
	executeInsert,
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
	 * The beta.13 pairwise merge engine. Used only when the store runs the legacy
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
			await this.checkConstraintsOptimistically(op)
			await this.cascadeLateChildOfOwnDelete(op)
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
		// RT-74: under end-to-end encryption with the relation's field sealed, the server
		// derives nothing; the effect is durable (kept at catch-up) and retired only by
		// the deleting device's real copy. Receivers author nothing: the deleting device
		// covers the children it knew, and cascades a child it learns of later itself
		// (cascadeLateChildOfOwnDelete); until then every device folds the same effect,
		// stamped right after the parent.
		await this.deps.store.applyProvisionalSideEffects(
			op,
			check.sideEffectOps.map((effect) => ({
				type: effect.type,
				collection: effect.collection,
				recordId: effect.recordId,
				data: effect.data,
				previousData: effect.previousData,
				ruleId: `relation:${effect.relationName}:${effect.type === 'delete' ? 'cascade' : 'set-null'}`,
				durable: this.deps.store.isRelationSealed(effect.relationName),
			})),
		)
		return result
	}

	/**
	 * RT-74: a remote write of a child under a sealed relation (the server cannot
	 * cascade it) whose parent THIS device deleted, and which this device has not
	 * cascaded yet (it did not know the child when it deleted the parent): this device,
	 * the parent delete's author, authors the cascade (or set-null) now, as a real
	 * operation naming the delete as a causal parent. It is the only device that does
	 * (one copy per child), and the receivers' durable provisional effects are retired
	 * by it. Without a sealed relation the server derives the late cascade instead.
	 */
	private async cascadeLateChildOfOwnDelete(op: Operation): Promise<void> {
		const store = this.deps.store
		const relations = store.getSchema().relations ?? {}
		for (const [name, relation] of Object.entries(relations)) {
			if (relation.from !== op.collection || !store.isRelationSealed(name)) continue
			const child = await store.findMaterializedRow(op.collection, op.recordId)
			if (!child || child.deleted) return
			const parentId = child.record[relation.field]
			if (typeof parentId !== 'string' || parentId.length === 0) continue
			const parent = await store.findMaterializedRow(relation.to, parentId)
			if (!parent?.deleted) continue
			const parentOps = await store.getOperationsForRecord(relation.to, parentId)
			const ownDelete = parentOps
				.filter(
					(candidate) => candidate.type === 'delete' && candidate.nodeId === store.getNodeId(),
				)
				.at(-1)
			if (!ownDelete) continue
			const childOps = await store.getOperationsForRecord(op.collection, op.recordId)
			const covered = childOps.some(
				(candidate) =>
					candidate.nodeId === store.getNodeId() && candidate.causalDeps.includes(ownDelete.id),
			)
			if (covered) continue
			const ctx = store.createMutationContext(relation.from, { extraCausalDeps: [ownDelete.id] })
			try {
				if (relation.onDelete === 'cascade') {
					await executeDelete(ctx, op.recordId)
					return
				}
				await executeUpdate(ctx, op.recordId, { [relation.field]: null })
			} catch (error) {
				// A restrict below the child, or a validation error: the child stays, and the
				// failure is reported rather than failing the remote apply.
				this.deps.emitter?.emit({
					type: 'sync:apply-failed',
					operationId: op.id,
					collection: op.collection,
					recordId: op.recordId,
					code: 'LATE_CASCADE_FAILED',
					message: `Late cascade of "${op.collection}/${op.recordId}" (relation "${name}") failed: ${error instanceof Error ? error.message : String(error)}`,
					retriable: false,
				})
			}
		}
	}

	/**
	 * Tier 2 constraints that span records (unique, capacity, referential) are
	 * evaluated optimistically here and authoritatively on the server: a violation
	 * is reported (`constraint:violated`) but not resolved locally, so every
	 * replica keeps folding the same operations and the server's correction, an
	 * ordinary operation, converges them.
	 */
	private async checkConstraintsOptimistically(op: Operation): Promise<void> {
		const emitter = this.deps.emitter
		const definition = this.deps.store.getSchema().collections[op.collection]
		if (!emitter || !definition || definition.constraints.length === 0) return
		const record = await this.deps.store.collection(op.collection).findById(op.recordId)
		if (!record) return
		const violations = await checkConstraints(
			record as Record<string, unknown>,
			op.recordId,
			op.collection,
			definition,
			{
				queryRecords: async (collection, where) =>
					(await this.deps.store.collection(collection).where(where).exec()) as Record<
						string,
						unknown
					>[],
				countRecords: (collection, where) =>
					this.deps.store.collection(collection).where(where).count(),
			},
		)
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

import type { KoraEventEmitter, MergeTrace, Operation, SchemaDefinition } from '@korajs/core'
import { HybridLogicalClock, KoraError, quoteIdent } from '@korajs/core'
import type { MergeEngine, ReferentialMergeContext, SideEffectOp } from '@korajs/merge'
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
		if (result === 'applied') await this.checkConstraintsOptimistically(op)
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
		await applySideEffectOps(this.deps.store, check.sideEffectOps, op)
		return result
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

/**
 * The cascades / set-nulls of a REMOTE delete, written as this device's operations.
 *
 * They are stamped right after the delete (its HLC, next logical ticks, this node),
 * exactly like the server's deterministic copy (`timestampAfter`), never with this
 * device's current time: a concurrent write to the child that is later than the delete
 * then wins over every copy, so the outcome does not depend on when this device
 * happened to apply the delete (Phase 3 seam 5). The copies are idempotent in effect
 * (two deletes, two writes of null).
 */
async function applySideEffectOps(
	store: Store,
	sideEffects: SideEffectOp[],
	parentOp: Operation,
): Promise<void> {
	const parent = parentOp.timestamp
	const clock = new HybridLogicalClock(store.getNodeId(), { now: () => parent.wallTime })
	clock.advanceTo(parent)
	for (const effect of sideEffects) {
		const ctx = store.createMutationContext(effect.collection, {
			extraCausalDeps: [parentOp.id],
			clock,
		})
		if (effect.type === 'delete') {
			await executeDelete(ctx, effect.recordId, { skipReferentialEnforcement: true })
		} else if (effect.type === 'update' && effect.data) {
			await executeUpdate(ctx, effect.recordId, effect.data)
		}
	}
}

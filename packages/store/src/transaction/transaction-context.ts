import type {
	CausalTracker,
	CollectionDefinition,
	HybridLogicalClock,
	Operation,
	SchemaDefinition,
	SecretKeyProvider,
} from '@korajs/core'
import {
	KoraError,
	generateUUIDv7,
	isAtomicOp,
	quoteIdent,
	resolveAtomicOp,
	validateRecord,
} from '@korajs/core'
import { RecordNotFoundError } from '../errors'
import type { RecordFolder } from '../fold/record-folder'
import { toAtRestWriteData } from '../mutations/secret-write'
import {
	CausalScope,
	type LocalDeleteHook,
	type WriteEnv,
	withWriteScope,
} from '../mutations/write-context'
import {
	type PreparedInsert,
	type WriteResult,
	prepareInsert,
	writeDeleteInTx,
	writeInsertInTx,
	writeUpdateInTx,
} from '../mutations/write-ops'
import type { RelationEnforcer } from '../relations/relation-enforcer'
import { deserializeRecord, toRichtextReadShape } from '../serialization/serializer'
import { validateUpdateStateMachine } from '../state-machine/state-validator'
import type { CollectionRecord, RawCollectionRow, StorageAdapter } from '../types'

/**
 * A buffered mutation. Buffered entries hold the developer's INTENT, not built
 * operations: they are written at commit, inside the commit's storage
 * transaction, through the same single local write path as single-record writes
 * (W6). That is what gives transaction writes in-transaction sequence
 * reservation, per-field version stamps, state-machine validation and atomic ops
 * resolved against the committed row.
 */
type BufferedEntry =
	| { readonly kind: 'insert'; readonly collection: string; readonly insert: PreparedInsert }
	| {
			readonly kind: 'update'
			readonly collection: string
			readonly id: string
			/** Schema-validated update data; may contain atomic op descriptors. */
			readonly data: Record<string, unknown>
	  }
	| { readonly kind: 'delete'; readonly collection: string; readonly id: string }

/**
 * Internal configuration for creating a TransactionContext.
 * Passed from Store to avoid exposing Store internals publicly.
 */
export interface TransactionContextConfig {
	schema: SchemaDefinition
	adapter: StorageAdapter
	clock: HybridLogicalClock
	nodeId: string
	relationEnforcer: RelationEnforcer | null
	causalTracker: CausalTracker | null
	/**
	 * Key provider for `t.secret()` encrypted fields. Transaction writes transform
	 * secret fields through the same helper as single-record writes (STORE-4).
	 */
	secretKeyProvider?: SecretKeyProvider
	/** Referential hook run for every local delete inside the commit (see {@link LocalDeleteHook}). */
	beforeLocalDelete?: LocalDeleteHook
	/** Called when the commit's storage transaction fails, before the error propagates. */
	onStorageError?: (error: unknown) => void
	/** The W7 record fold (see `WriteEnv.fold`). */
	fold?: RecordFolder
}

/**
 * A collection accessor within a transaction.
 * Operations are buffered and committed atomically when the transaction completes.
 */
export interface TransactionCollectionAccessor {
	insert(data: Record<string, unknown>): Promise<CollectionRecord>
	update(id: string, data: Record<string, unknown>): Promise<CollectionRecord>
	delete(id: string): Promise<void>
	findById(id: string): Promise<CollectionRecord | null>
}

/**
 * TransactionContext provides atomic multi-collection operations.
 *
 * Mutations are validated and buffered when called (so errors surface at the
 * call site and `insert` returns the new id immediately), then written in a
 * single `StorageAdapter.transaction()` at commit. All operations share the
 * same transactionId (UUID v7) and one contiguous block of sequence numbers.
 *
 * Subscription notifications are deferred until after commit.
 *
 * @example
 * ```typescript
 * const { operations, affectedCollections } = await txContext.commit()
 * // Notify subscriptions after commit
 * for (const op of operations) {
 *   subscriptionManager.notify(op.collection, op)
 * }
 * ```
 */
export class TransactionContext {
	private readonly transactionId: string
	private mutationName: string | undefined
	private readonly buffer: BufferedEntry[] = []
	private committed = false
	private rolledBack = false
	private readonly config: TransactionContextConfig

	constructor(config: TransactionContextConfig) {
		this.config = config
		this.transactionId = generateUUIDv7()
	}

	/**
	 * Set a human-readable mutation name for this transaction.
	 * Propagated to all operations for DevTools display.
	 */
	setMutationName(name: string): void {
		this.mutationName = name
	}

	/**
	 * Get the mutation name, if set.
	 */
	getMutationName(): string | undefined {
		return this.mutationName
	}

	/**
	 * Get a collection accessor for buffered operations within this transaction.
	 */
	collection(name: string): TransactionCollectionAccessor {
		const definition = this.config.schema.collections[name]
		if (!definition) {
			throw new KoraError(
				`Unknown collection "${name}". Available: ${Object.keys(this.config.schema.collections).join(', ')}`,
				'UNKNOWN_COLLECTION',
				{ collection: name },
			)
		}

		return {
			insert: (data: Record<string, unknown>) => this.insert(name, data),
			update: (id: string, data: Record<string, unknown>) =>
				this.update(name, definition, id, data),
			delete: (id: string) => this.deleteRecord(name, definition, id),
			findById: (id: string) => this.getEffectiveRecord(name, definition, id),
		}
	}

	/**
	 * Commit all buffered mutations atomically.
	 *
	 * Every entry is written, in call order, inside ONE storage transaction through
	 * the single local write path: sequence numbers are reserved inside the
	 * transaction (one contiguous block covering referential side effects too) and
	 * each operation is built only after its number is reserved.
	 *
	 * Returns the list of operations and affected collections for subscription notification.
	 */
	async commit(): Promise<{ operations: Operation[]; affectedCollections: Set<string> }> {
		if (this.committed) {
			throw new KoraError('Transaction already committed.', 'TRANSACTION_COMMITTED', {
				transactionId: this.transactionId,
			})
		}
		if (this.rolledBack) {
			throw new KoraError(
				'Transaction was rolled back and cannot be committed.',
				'TRANSACTION_ROLLED_BACK',
				{ transactionId: this.transactionId },
			)
		}

		this.committed = true

		if (this.buffer.length === 0) {
			return { operations: [], affectedCollections: new Set() }
		}

		const env = this.writeEnv()
		const causal = new CausalScope(this.config.causalTracker, true)
		const operations: Operation[] = []

		try {
			await this.config.adapter.transaction(async (tx) => {
				await withWriteScope(tx, env.nodeId, causal, async (scope) => {
					for (const entry of this.buffer) {
						let result: WriteResult
						switch (entry.kind) {
							case 'insert':
								result = await writeInsertInTx(env, scope, entry.insert)
								break
							case 'update':
								result = await writeUpdateInTx(env, scope, entry.collection, entry.id, entry.data)
								break
							case 'delete':
								result = await writeDeleteInTx(env, scope, entry.collection, entry.id)
								break
						}
						if (result.operation) operations.push(result.operation)
						operations.push(...result.sideEffects)
					}
				})
			})
		} catch (error) {
			this.config.onStorageError?.(error)
			throw error
		}

		causal.publish()
		const affectedCollections = new Set(operations.map((op) => op.collection))
		return { operations, affectedCollections }
	}

	/**
	 * Mark the transaction as rolled back. No operations will be committed.
	 */
	rollback(): void {
		this.rolledBack = true
		this.buffer.length = 0
	}

	/**
	 * Get the transaction ID shared by all operations in this transaction.
	 */
	getTransactionId(): string {
		return this.transactionId
	}

	private writeEnv(): WriteEnv {
		return {
			schema: this.config.schema,
			clock: this.config.clock,
			nodeId: this.config.nodeId,
			relationEnforcer: this.config.relationEnforcer,
			transactionId: this.transactionId,
			...(this.config.secretKeyProvider
				? { secretKeyProvider: this.config.secretKeyProvider }
				: {}),
			...(this.mutationName !== undefined ? { mutationName: this.mutationName } : {}),
			...(this.config.beforeLocalDelete
				? { beforeLocalDelete: this.config.beforeLocalDelete }
				: {}),
			...(this.config.fold ? { fold: this.config.fold } : {}),
		}
	}

	private ensureActive(): void {
		if (this.committed) {
			throw new KoraError(
				'Cannot perform operations on a committed transaction.',
				'TRANSACTION_COMMITTED',
				{ transactionId: this.transactionId },
			)
		}
		if (this.rolledBack) {
			throw new KoraError(
				'Cannot perform operations on a rolled-back transaction.',
				'TRANSACTION_ROLLED_BACK',
				{ transactionId: this.transactionId },
			)
		}
	}

	private async insert(
		collectionName: string,
		data: Record<string, unknown>,
	): Promise<CollectionRecord> {
		this.ensureActive()
		const insert = await prepareInsert(this.writeEnv(), collectionName, data)
		this.buffer.push({ kind: 'insert', collection: collectionName, insert })
		const now = Date.now()
		// The returned record carries the at-rest form (secrets hashed/encrypted) and the
		// read form of richtext (bytes), exactly like a single-record insert.
		const fields = this.config.schema.collections[collectionName]?.fields ?? {}
		return {
			id: insert.recordId,
			...toRichtextReadShape(insert.data, fields),
			createdAt: now,
			updatedAt: now,
		}
	}

	private async update(
		collectionName: string,
		definition: CollectionDefinition,
		id: string,
		data: Record<string, unknown>,
	): Promise<CollectionRecord> {
		this.ensureActive()

		const currentRecord = await this.getEffectiveRecord(collectionName, definition, id)
		if (!currentRecord) {
			throw new RecordNotFoundError(collectionName, id)
		}

		const validated = validateRecord(collectionName, definition, data, 'update')
		// Early check so an invalid transition fails at the call site. The commit
		// re-validates against the row read inside the write transaction, which is
		// authoritative.
		const allowed = validateUpdateStateMachine(
			collectionName,
			id,
			definition,
			currentRecord,
			validated,
		)
		this.buffer.push({ kind: 'update', collection: collectionName, id, data: validated })

		const preview = await this.previewUpdate(definition, currentRecord, allowed)
		return { ...currentRecord, ...preview, updatedAt: Date.now() } as CollectionRecord
	}

	private async deleteRecord(
		collectionName: string,
		definition: CollectionDefinition,
		id: string,
	): Promise<void> {
		this.ensureActive()

		const currentRecord = await this.getEffectiveRecord(collectionName, definition, id)
		if (!currentRecord) {
			throw new RecordNotFoundError(collectionName, id)
		}
		this.buffer.push({ kind: 'delete', collection: collectionName, id })
	}

	/**
	 * The values an update will write, resolved against `current` (the effective
	 * record) for read-your-writes inside the transaction. Secret fields are shown
	 * in their at-rest form, like the record a committed update returns.
	 */
	private async previewUpdate(
		definition: CollectionDefinition,
		current: CollectionRecord,
		data: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const resolved: Record<string, unknown> = {}
		for (const [key, value] of Object.entries(data)) {
			resolved[key] = isAtomicOp(value) ? resolveAtomicOp(current[key], value) : value
		}
		const atRest = await toAtRestWriteData(resolved, definition, this.config.secretKeyProvider)
		return toRichtextReadShape(atRest, definition.fields)
	}

	/**
	 * The effective state of a record: the committed row overlaid with this
	 * transaction's buffered mutations, in call order.
	 */
	private async getEffectiveRecord(
		collectionName: string,
		definition: CollectionDefinition,
		id: string,
	): Promise<CollectionRecord | null> {
		const rows = await this.config.adapter.query<RawCollectionRow>(
			`SELECT * FROM ${quoteIdent(collectionName)} WHERE id = ? AND _deleted = 0`,
			[id],
		)
		let record: CollectionRecord | null = rows[0]
			? deserializeRecord(rows[0], definition.fields)
			: null

		for (const entry of this.buffer) {
			if (entry.collection !== collectionName) continue
			if (entry.kind === 'insert') {
				if (entry.insert.recordId !== id) continue
				const now = Date.now()
				record = {
					id,
					...toRichtextReadShape(entry.insert.data, definition.fields),
					createdAt: now,
					updatedAt: now,
				}
			} else if (entry.id === id && entry.kind === 'update') {
				if (record) {
					let allowed: Record<string, unknown>
					try {
						allowed = validateUpdateStateMachine(collectionName, id, definition, record, entry.data)
					} catch {
						// Already reported to the caller when the update was buffered.
						allowed = {}
					}
					const preview = await this.previewUpdate(definition, record, allowed)
					record = { ...record, ...preview, updatedAt: Date.now() }
				}
			} else if (entry.id === id) {
				record = null
			}
		}

		return record
	}
}

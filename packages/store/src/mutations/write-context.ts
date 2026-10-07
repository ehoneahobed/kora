import type {
	CausalTracker,
	HybridLogicalClock,
	Operation,
	SchemaDefinition,
	SecretKeyProvider,
} from '@korajs/core'
import { KoraError } from '@korajs/core'
import type { RecordFolder } from '../fold/record-folder'
import type { RelationEnforcer } from '../relations/relation-enforcer'
import type { Transaction } from '../types'

/**
 * Called inside the write transaction for every local delete, after the delete
 * operation is built and before referential side effects run. Lets the unified
 * apply pipeline run its referential checks (and emit their traces) against the
 * rows the transaction sees. Throwing aborts the whole write.
 */
export type LocalDeleteHook = (operation: Operation, tx: Transaction) => Promise<void>

/**
 * Everything the single local write path needs to build and persist an
 * operation inside a storage transaction. One environment serves single-record
 * writes, `app.transaction` commits and referential cascades, so every local
 * operation is built the same way (W6).
 */
export interface WriteEnv {
	readonly schema: SchemaDefinition
	readonly clock: HybridLogicalClock
	readonly nodeId: string
	readonly relationEnforcer: RelationEnforcer | null
	readonly secretKeyProvider?: SecretKeyProvider
	/** Shared by every operation of an `app.transaction` / `app.mutation` commit. */
	readonly transactionId?: string
	/** Human-readable mutation name propagated to every operation (DevTools). */
	readonly mutationName?: string
	/** See {@link LocalDeleteHook}. */
	readonly beforeLocalDelete?: LocalDeleteHook
	/**
	 * The W7 record fold. When set, a local write appends its operation and then
	 * merges it into the record's fold state, which re-materializes the row (the
	 * same path remote operations take). Absent only under
	 * `experimental.legacyMerge` (and while a pre-W7 database is migrated, before its
	 * re-materialization): the row is then written directly, as in beta.12.
	 */
	readonly fold?: RecordFolder
	/**
	 * Largest operation a local write may produce (RT-86), the server's
	 * `maxOperationBytes`. Default `DEFAULT_MAX_OPERATION_BYTES` (256 KiB).
	 */
	readonly maxOperationBytes?: number
	/**
	 * Throws when local writes are not allowed right now: the store's pinned node
	 * belongs to another user than the one signed in (F9). Called before every local
	 * operation is built.
	 */
	readonly assertLocalWriteAllowed?: () => void
}

/**
 * Causal bookkeeping for the operations built inside ONE storage transaction.
 *
 * Dependencies are computed from the committed causal heads (the shared
 * {@link CausalTracker}) overlaid with the operations already built in this
 * transaction. Heads are published to the shared tracker only after the
 * transaction commits, so a rolled-back write never leaves a dependency on an
 * operation that does not exist.
 */
export class CausalScope {
	private readonly lastByCollection = new Map<string, string>()
	private lastInScope: string | null = null
	private readonly recorded: Array<{ collection: string; id: string }> = []

	constructor(
		private readonly tracker: CausalTracker | null,
		/** When true, every operation also depends on the previous one in this scope. */
		private readonly chainOperations: boolean,
	) {}

	/**
	 * Direct causal parents for the next operation in `collection`.
	 *
	 * @param collection - Collection of the operation being built
	 * @param extra - Explicit parents (e.g. the delete that caused a cascade)
	 */
	depsFor(collection: string, extra: readonly string[] = []): string[] {
		const deps: string[] = []
		const add = (id: string | undefined | null): void => {
			if (id && !deps.includes(id)) deps.push(id)
		}
		for (const id of extra) add(id)
		const local = this.lastByCollection.get(collection)
		if (local !== undefined) {
			add(local)
		} else {
			for (const id of this.tracker?.nextCausalDeps(collection, false) ?? []) add(id)
		}
		if (this.chainOperations) add(this.lastInScope)
		return deps
	}

	/** Record an operation built in this scope. */
	record(collection: string, operationId: string): void {
		this.lastByCollection.set(collection, operationId)
		this.lastInScope = operationId
		this.recorded.push({ collection, id: operationId })
	}

	/** Publish this scope's heads to the shared tracker. Call only after commit. */
	publish(): void {
		for (const { collection, id } of this.recorded) {
			this.tracker?.afterOperation(collection, id, false)
		}
	}
}

/**
 * The sequence-number block of ONE write transaction.
 *
 * The first number is reserved with one `UPSERT ... RETURNING` on
 * `_kora_version_vector`, inside the transaction; later numbers continue the block
 * in memory, and {@link SequenceBlock.close} persists the block's end with one
 * write before the transaction commits. Write transactions are serialized and no
 * code path allocates numbers outside one, so the block is contiguous and never
 * shared; the UNIQUE `(node_id, sequence_number)` index on every op table is the
 * backstop. A rollback discards the reservation with everything else.
 */
export class SequenceBlock {
	private last: number | null = null
	private persisted = 0

	constructor(
		private readonly tx: Transaction,
		private readonly nodeId: string,
	) {}

	/** The next number of the block. */
	async take(): Promise<number> {
		if (this.last === null) {
			const rows = await this.tx.query<{ sequence_number: number }>(
				`INSERT INTO _kora_version_vector (node_id, sequence_number) VALUES (?, 1)
     ON CONFLICT(node_id) DO UPDATE SET sequence_number = sequence_number + 1
     RETURNING sequence_number`,
				[this.nodeId],
			)
			const first = rows[0]?.sequence_number
			if (first === undefined) {
				throw new KoraError(
					`Failed to reserve a sequence number for node "${this.nodeId}"`,
					'SEQUENCE_RESERVATION_FAILED',
					{ nodeId: this.nodeId },
				)
			}
			this.last = first
			this.persisted = first
			return first
		}
		this.last += 1
		return this.last
	}

	/** Persist the end of the block. Must run inside the transaction, before commit. */
	async close(): Promise<void> {
		if (this.last === null || this.last === this.persisted) return
		await this.tx.execute(
			'UPDATE _kora_version_vector SET sequence_number = MAX(sequence_number, ?) WHERE node_id = ?',
			[this.last, this.nodeId],
		)
		this.persisted = this.last
	}
}

/**
 * The per-transaction state of a local write: the transaction handle, its
 * sequence block and its causal scope. Every operation built in one transaction
 * takes the next number of the same contiguous block.
 */
export interface WriteScope {
	readonly tx: Transaction
	readonly sequence: SequenceBlock
	readonly causal: CausalScope
}

/**
 * Run `write` with a fresh {@link WriteScope} on `tx`, then close the sequence
 * block (still inside the transaction).
 */
export async function withWriteScope<T>(
	tx: Transaction,
	nodeId: string,
	causal: CausalScope,
	write: (scope: WriteScope) => Promise<T>,
): Promise<T> {
	const scope: WriteScope = { tx, sequence: new SequenceBlock(tx, nodeId), causal }
	const result = await write(scope)
	await scope.sequence.close()
	return result
}

/**
 * Whether a storage error means the device ran out of space: SQLite's
 * `SQLITE_FULL` ("database or disk is full") or a browser quota error from OPFS /
 * IndexedDB. The store maps these to a `store:quota-exceeded` event (STORE-15).
 */
export function isStorageFullError(error: unknown): boolean {
	if (error === null || typeof error !== 'object') return false
	const candidate = error as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown }
	if (candidate.name === 'QuotaExceededError') return true
	if (candidate.code === 'SQLITE_FULL' || candidate.code === 'QUOTA_EXCEEDED') return true
	const message = typeof candidate.message === 'string' ? candidate.message : ''
	if (/SQLITE_FULL|database or disk is full|quota ?exceeded/i.test(message)) return true
	return candidate.cause !== undefined && candidate.cause !== error
		? isStorageFullError(candidate.cause)
		: false
}

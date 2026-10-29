import type { Transaction, TransactionStatement } from '../types'

/**
 * Statements buffered before they are sent. Bounds the size of one worker message
 * and how long one batch holds the SQLite worker (follower tabs queue behind it).
 */
export const WRITE_BEHIND_MAX_STATEMENTS = 256

/**
 * A {@link Transaction} that buffers writes and sends them in batches.
 *
 * Used where every failing statement aborts the whole unit of work it belongs to, so
 * no caller catches one statement's error and carries on with the same buffer:
 *
 * - the local write path, inside the storage transaction of a write
 *   (`withWriteScope`): a failure aborts the write;
 * - a delivery batch applied in one transaction (`Store.applyRemoteBatch`), one
 *   instance per step (an operation or a retraction) inside that step's savepoint: a
 *   failure aborts the step, whose savepoint is rolled back only after
 *   {@link settled}, so nothing of the step lands after it; the next step gets a fresh
 *   instance.
 *
 * That is what makes buffering invisible:
 *
 * - statements reach the database in the order they were issued;
 * - every read ({@link query}) first sends the buffered writes and waits for them,
 *   so reads see them;
 * - {@link flush} runs before the write scope (or the step) ends, so every statement
 *   has been applied before the adapter commits (or the savepoint is released); a
 *   failing statement rejects that flush (or an earlier read or `execute`) and the
 *   whole write (or step) is rolled back, exactly as when the statement's own
 *   `execute` failed. Once a batch failed, nothing more is sent.
 *
 * The only difference a caller can observe is WHICH await rejects: a deferred
 * statement's error surfaces at a later read, `execute` or the end of the write,
 * never after the write resolved. Code that must catch a statement's error and
 * carry on (the migration runner's tolerated DDL) uses the raw handle.
 *
 * A full buffer is sent without waiting for it, so the next statements are built
 * while the worker runs the batch; at most one batch is in flight (a second full
 * buffer waits for the first), which bounds memory.
 *
 * With an adapter that implements {@link Transaction.executeBatch} (SQLite WASM:
 * one worker message per batch instead of one per statement) this removes most
 * worker round trips of a large write; other adapters get the statements one
 * `execute` at a time, in order, as before.
 */
export class WriteBehindTransaction implements Transaction {
	private pending: TransactionStatement[] = []
	/** The batch in flight (settles after every earlier batch). */
	private sending: Promise<void> = Promise.resolve()
	private inFlight = false
	private sentAny = false
	/** The first batch failure, recorded as soon as it happens (see {@link execute}). */
	private failure: { error: unknown } | null = null

	constructor(
		private readonly inner: Transaction,
		private readonly maxStatements = WRITE_BEHIND_MAX_STATEMENTS,
	) {}

	async execute(sql: string, params?: unknown[]): Promise<void> {
		// A batch already failed: the write is aborted, so say so at the next statement
		// instead of buffering more work that will never be sent.
		if (this.failure) throw this.failure.error
		this.pending.push(params === undefined ? { sql } : { sql, params })
		if (this.pending.length < this.maxStatements) return
		// Backpressure: one batch in flight. Waiting also surfaces its failure here.
		if (this.inFlight) await this.sending
		this.dispatch()
	}

	async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
		await this.flush()
		return this.inner.query<T>(sql, params)
	}

	async executeBatch(statements: readonly TransactionStatement[]): Promise<void> {
		this.pending.push(...statements)
		await this.flush()
	}

	/** Send every buffered statement and wait until all of them ran (or one failed). */
	flush(): Promise<void> {
		this.dispatch()
		return this.sending
	}

	/**
	 * A view of this transaction whose `execute` resolves only once its statement ran
	 * (and rejects with that statement's own error), for code that relies on that, such
	 * as the public `LocalMutationHandler.beforeLocalDelete` hook. Buffered statements
	 * are sent first, so order is kept.
	 */
	immediate(): Transaction {
		return {
			execute: async (sql, params) => {
				await this.flush()
				await this.inner.execute(sql, params)
			},
			query: (sql, params) => this.query(sql, params),
		}
	}

	/**
	 * Drop the statements not yet sent. Returns whether any statement of this buffer was
	 * ever sent (so the caller knows what it must undo: with nothing sent, nothing happened).
	 */
	discardUnsent(): boolean {
		this.pending = []
		return this.sentAny
	}

	/** Resolves once every batch already sent has settled (never rejects). */
	settled(): Promise<void> {
		return this.sending.then(
			() => undefined,
			() => undefined,
		)
	}

	private dispatch(): void {
		if (this.pending.length === 0) return
		const batch = this.pending
		this.pending = []
		this.sentAny = true
		this.inFlight = true
		// Chained: batches run in issue order, and after a failed batch every later one
		// is skipped and every later flush rejects with that failure.
		const next = this.sending.then(() => this.send(batch))
		this.sending = next
		next.then(
			() => {
				if (this.sending === next) this.inFlight = false
			},
			(error: unknown) => {
				// Recorded at once, so the next execute throws; also observed by the next
				// query or flush. Marked handled here so a failure is not reported as
				// unhandled while the caller builds the next statement.
				if (!this.failure) this.failure = { error }
			},
		)
	}

	private async send(batch: readonly TransactionStatement[]): Promise<void> {
		if (this.inner.executeBatch) {
			await this.inner.executeBatch(batch)
			return
		}
		for (const statement of batch) {
			await this.inner.execute(statement.sql, statement.params)
		}
	}
}

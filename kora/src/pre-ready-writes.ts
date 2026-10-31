import {
	KoraError,
	currentWriteObserver,
	generateUUIDv7,
	isAtomicOp,
	runWithWriteObserver,
} from '@korajs/core/lite'
import type { WriteObserver } from '@korajs/core/lite'
import type { WriteOptions } from '@korajs/store'
import type { JournalEntry, JournaledWriteKind, WriteJournal } from './write-journal'

/** The slice of the store a replay needs; `Store` satisfies it. */
export interface WriteTarget {
	/** This device's node id: operations of other nodes are other devices' (or tabs') edits. */
	getNodeId?(): string
	/** Every operation for a record, tombstones included; how a replay recognises what already happened. */
	getOperationsForRecord?(
		collection: string,
		recordId: string,
	): Promise<Array<{ type: string; nodeId: string; timestamp: { wallTime: number } }>>
	collection(name: string): {
		insert(data: Record<string, unknown>, options?: WriteOptions): Promise<unknown>
		insertMany(rows: readonly Record<string, unknown>[], options?: WriteOptions): Promise<unknown>
		update(id: string, data: Record<string, unknown>, options?: WriteOptions): Promise<unknown>
		delete(id: string, options?: WriteOptions): Promise<void>
		findById(id: string): Promise<unknown>
	}
}

/** Matches `FIXED_WRITE_KEY` of `@korajs/store` (a shared symbol, so no import is needed). */
const FIXED_WRITE_KEY = Symbol.for('korajs.store.fixedWrite')

/** The part of the Web Locks API the queue uses. */
export interface LockManagerLike {
	request(
		name: string,
		options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
		callback: (lock: unknown) => Promise<unknown>,
	): Promise<unknown>
	query?(): Promise<{ held?: Array<{ name?: string }> }>
}

export interface PreReadyWriteQueueOptions {
	/** The local database the writes will go to. */
	dbName: string
	/** The signed-in user, when the app can tell (`sync.authClient.resolveUserId`). */
	resolveOwner?: () => Promise<string | undefined>
	/** Override the journal (tests); defaults to IndexedDB, or none outside a browser. */
	journal?: WriteJournal | null
	/** Override the Web Locks manager (tests); defaults to `navigator.locks`. */
	locks?: LockManagerLike | null
	/** Override the session id (tests). */
	session?: string
	/** Override the clock (tests). */
	now?: () => number
	/**
	 * Why writes to a collection may not be saved to the journal, or null when they may. The
	 * journal holds the arguments as the caller gave them, before the store's at-rest transform
	 * (secret fields, end-to-end encryption) could run, so a collection that needs that
	 * transform stays in memory only. Defaults to every collection.
	 */
	journalBlock?: (collection: string) => 'secret-field' | 'encryption' | null
	/** How long to wait for the signed-in user before the entry stays owner-pending. Default 3000. */
	ownerTimeoutMs?: number
	/** Longest a single journal call may take before the write is treated as not journaled. Default 2000. */
	journalTimeoutMs?: number
	/** Longest recovery of a closed tab's writes may hold `ready`. Default 5000. */
	recoveryBudgetMs?: number
	/**
	 * True when the app keeps one local database per signed-in user. A write whose owner is
	 * unknown is then held (never applied into another user's database); otherwise the first
	 * user to open the app claims it.
	 */
	namespacedByUser?: boolean
	/** Receives `journal:write-failed` and `journal:memory-only` events. */
	emit?: (event: JournalFailureEvent | JournalMemoryOnlyEvent) => void
}

/** The event a write that is held in memory only raises. */
export interface JournalMemoryOnlyEvent {
	type: 'journal:memory-only'
	dbName: string
	collection: string
	kind: string
	reason:
		| 'atomic-operation'
		| 'secret-field'
		| 'encryption'
		| 'binary-value'
		| 'no-storage'
		| 'journal-error'
		| 'journal-timeout'
	pending: number
}

/** The event a recovered write that could not be applied raises. */
export interface JournalFailureEvent {
	type: 'journal:write-failed'
	dbName: string
	collection: string
	kind: string
	message: string
	permanent: boolean
}

const SESSION_LOCK_PREFIX = 'kora-journal-session:'
const DEFAULT_JOURNAL_TIMEOUT_MS = 2000
const DEFAULT_OWNER_TIMEOUT_MS = 3000
const DEFAULT_RECOVERY_BUDGET_MS = 5000

interface Pending {
	collection: string
	kind: JournaledWriteKind
	args: unknown[]
	options: WriteOptions | undefined
	observer: WriteObserver | null
	/** Fixed at enqueue: see {@link JournalEntry.recordId}. */
	recordId: string | undefined
	recordIds: string[] | undefined
	writtenAt: number
	resolve: (value: unknown) => void
	reject: (reason: unknown) => void
	/** The journal sequence number once saved; null when this write is memory-only. */
	appended: Promise<number | null>
	/** Whether the write is held in memory only (counted by `journal:memory-only`). */
	memoryOnly: boolean
}

/** What a replayed journal entry turned out to be. */
export type ReplayOutcome = 'applied' | 'skipped'

/**
 * Writes made through a framework hook before the store opened.
 *
 * Each write is held in memory (its promise resolves when it has been applied to the open
 * store, in call order) and saved to the {@link WriteJournal} at once, before anything else
 * is awaited, so closing the tab before the store opens does not lose it: the next session
 * that opens the same database applies it ({@link PreReadyWriteQueue.apply}).
 *
 * Exactly-once: the record id of an insert and the time of the write are fixed when the user
 * acts and stored with the entry. A replay then consults the operation log, tombstones
 * included: an insert whose record has any operation is skipped (never resurrected after a
 * delete); an update or delete is skipped when the record is gone, when another device wrote
 * it after the user acted, or when an interrupted earlier pass already applied it.
 *
 * Every journal call is bounded in time. A journal that does not answer (stuck IndexedDB) makes
 * the write memory-only, announced with `journal:memory-only`; it never holds the drain, the
 * store or `ready`.
 *
 * Memory only (they wait for the store but do not survive a closed tab): writes that use
 * atomic helpers (`op.increment`, ...), which hold symbols that cannot be saved and would be
 * wrong to apply twice; values that are files or binary buffers; and writes to a collection
 * `journalBlock` refuses (secret fields, end-to-end encryption: the journal would hold
 * plaintext).
 */
export class PreReadyWriteQueue {
	/**
	 * The journal opens on first use, from its own chunk: the IndexedDB code is not needed to
	 * paint, only to save the first write or to look at what a closed tab left.
	 */
	private journalPromise: Promise<WriteJournal | null> | null = null
	private readonly journalOverride: WriteJournal | null | undefined
	private readonly locks: LockManagerLike | null
	private readonly session: string
	private readonly now: () => number
	private readonly pending: Pending[] = []
	private store: WriteTarget | null = null
	private draining = false
	private failure: KoraError | null = null
	/** The signed-in user once the app said who it is (a timeout is never remembered). */
	private knownOwner: { owner: string | null } | null = null
	private sessionLock: Promise<void> | null = null
	private releaseSessionLock: (() => void) | null = null
	private scanned: Promise<JournalEntry[]> | null = null
	private warned = false
	private readonly warnedReasons = new Set<string>()
	/** Journal bookkeeping still running (removing applied entries, patching owners). */
	private readonly settling = new Set<Promise<void>>()
	private detachPageHide: (() => void) | null = null

	constructor(private readonly options: PreReadyWriteQueueOptions) {
		this.journalOverride = options.journal
		this.locks = options.locks === undefined ? defaultLocks() : options.locks
		this.session = options.session ?? randomSession()
		this.now = options.now ?? Date.now
	}

	private get journalTimeout(): number {
		return this.options.journalTimeoutMs ?? DEFAULT_JOURNAL_TIMEOUT_MS
	}

	/** Bound a journal call: past the limit the journal is treated as not answering. */
	private bounded<T>(work: Promise<T>, what: string): Promise<T> {
		return withTimeout(work, this.journalTimeout, what)
	}

	private getJournal(): Promise<WriteJournal | null> {
		this.journalPromise ??= (async () => {
			if (this.journalOverride !== undefined) return this.journalOverride
			// No IndexedDB (a server render, a Node script): the queue is memory only.
			if (typeof indexedDB === 'undefined' || indexedDB === null) return null
			const { openWriteJournal } = await import('./write-journal')
			return openWriteJournal(this.options.dbName)
		})()
		return this.journalPromise
	}

	/** Writes held in memory right now. */
	get size(): number {
		return this.pending.length
	}

	/** Writes held in memory only: lost if the page closes before the store opens. */
	get memoryOnlyCount(): number {
		return this.pending.filter((item) => item.memoryOnly).length
	}

	/**
	 * Whether a write made now, outside a hook's synchronous part, still belongs to the queue:
	 * the store is being drained or just finished. A mutation that awaits one write and then
	 * makes another (`await a.insert(); await b.insert()`) is in this window for its second
	 * write, and must not be refused halfway.
	 */
	get acceptsDirectWrites(): boolean {
		return this.draining || this.store !== null
	}

	/** Resolves when the journal bookkeeping started so far has finished (tests, shutdown). */
	async settled(): Promise<void> {
		while (this.settling.size > 0) await Promise.all([...this.settling])
	}

	/**
	 * Start reading the journal now, while the store is still opening, so the recovery step
	 * before `ready` finds the answer already there (an empty journal costs nothing then).
	 */
	scan(): void {
		if (this.scanned) return
		this.scanned = this.bounded(
			this.getJournal().then((journal) => journal?.list() ?? []),
			'read the write journal',
		).catch((error: unknown) => {
			this.warnRecovery(error)
			return []
		})
	}

	/**
	 * Queue a write. Must be called synchronously from the hook's mutation function so the
	 * write observer is still current. Resolves with what the store's method returns.
	 * Rejects at once when the store failed to open or the app was closed.
	 */
	enqueue(
		collection: string,
		kind: JournaledWriteKind,
		args: unknown[],
		options?: WriteOptions,
	): Promise<unknown> {
		const observer = currentWriteObserver()
		if (this.failure) return Promise.reject(this.failure)
		const writtenAt = this.now()
		const ids = assignRecordIds(kind, args)
		if (this.store) {
			return this.run(
				this.store,
				{ collection, kind, args, options, ...ids, writtenAt },
				observer,
			)
		}
		this.watchPageHide()
		return new Promise<unknown>((resolve, reject) => {
			const item: Pending = {
				collection,
				kind,
				args,
				options,
				observer,
				...ids,
				writtenAt,
				resolve,
				reject,
				appended: Promise.resolve(null),
				memoryOnly: false,
			}
			// Saved before anything else is awaited: the entry exists as soon as IndexedDB
			// accepts it, whatever the signed-in user lookup or the store take.
			item.appended = this.persist(item)
			this.pending.push(item)
		})
	}

	/**
	 * Apply what a closed tab left behind (within a time budget), then every write queued in
	 * this session, in order, and from then on pass writes straight to the store. Called once,
	 * as the last step before `app.ready` resolves.
	 */
	async apply(store: WriteTarget): Promise<void> {
		this.draining = true
		const held = await this.recover(store)
		while (this.pending.length > 0) {
			const item = this.pending.shift()
			if (!item) break
			if (held.size > 0 && (await this.blockedByOlderWrite(item, held))) continue
			try {
				item.resolve(await this.run(store, item, item.observer))
			} catch (error) {
				item.reject(error)
			}
			this.track(this.forget(item))
		}
		// No await between the empty check above and this line: a write cannot slip into the
		// queue after the drain ended and be left behind.
		this.store = store
		this.draining = false
		this.unwatchPageHide()
		// The journal has nothing more to do this session; the connection must not block a wipe.
		void this.releaseJournal().catch(() => {})
	}

	/**
	 * A write to a record whose older journaled write could not be applied yet must not land
	 * first. When it is saved in the journal it stays there (applied after the older one at the
	 * next start) and its caller is told so; one held in memory only goes ahead, since nothing
	 * could replay it.
	 */
	private async blockedByOlderWrite(item: Pending, held: ReadonlySet<string>): Promise<boolean> {
		const id = targetRecordId(item.kind, item.args)
		if (id === undefined || !held.has(recordKey(item.collection, id))) return false
		const seq = await item.appended
		if (seq === null) return false
		item.reject(
			new KoraError(
				`The write to "${item.collection}" was saved on this device but not applied yet: an older write to the same record is waiting for the storage to be ready. It is applied at the next start, after the older one; do not repeat it.`,
				'WRITE_NOT_APPLIED',
				{ collection: item.collection, savedForLater: true },
			),
		)
		return true
	}

	/**
	 * The store will not open: fail every waiting write and every later one with an error that
	 * says what happened to it. A write saved to the journal is KEPT (it applies at the next
	 * start, and the error says so); one held in memory only is lost, and the error says that.
	 */
	async fail(error: unknown): Promise<void> {
		await this.refuse(error, 'The local database did not open')
	}

	/** The app was closed before the store opened: same as {@link PreReadyWriteQueue.fail}. */
	async close(): Promise<void> {
		await this.refuse(undefined, 'The app was closed before the local database opened')
	}

	private async refuse(cause: unknown, why: string): Promise<void> {
		const items = this.pending.splice(0)
		// Set before the first await so a write made meanwhile is refused too.
		this.failure ??= new KoraError(`${why}, so this write was not applied.`, 'WRITE_NOT_APPLIED', {
			cause: cause instanceof Error ? cause.message : cause === undefined ? null : String(cause),
		})
		this.unwatchPageHide()
		// Each saved-ness is already bounded in time, so a stuck journal cannot hold this.
		const saved = await Promise.all(items.map((item) => item.appended))
		items.forEach((item, index) => {
			const kept = saved[index] !== null
			item.reject(
				new KoraError(
					`${why}, so the write to "${item.collection}" was not applied. ${
						kept
							? 'It was saved on this device and is applied the next time the app opens; do not repeat it.'
							: 'It was held in memory only and is lost; repeat it once the app is open.'
					}`,
					'WRITE_NOT_APPLIED',
					{
						collection: item.collection,
						savedForLater: kept,
						cause:
							cause instanceof Error ? cause.message : cause === undefined ? null : String(cause),
					},
				),
			)
		})
		await this.settled()
		await this.releaseJournal()
		// The page-lifetime lock told other tabs this session is alive; a session that ended
		// (or never will apply) must not look alive to a new app created in the same page.
		this.releaseSessionLock?.()
		this.releaseSessionLock = null
		this.sessionLock = null
	}

	/**
	 * Delete the journal of this database: the local database was wiped or the user signed out,
	 * so queued plaintext must not outlive the data it was meant for.
	 */
	async discardJournal(): Promise<void> {
		this.scanned = null
		try {
			const open = this.journalPromise ? await this.journalPromise.catch(() => null) : null
			this.journalPromise = null
			open?.close()
			const { deleteWriteJournal } = await import('./write-journal')
			await deleteWriteJournal(this.options.dbName)
		} catch (error) {
			console.warn('[kora] Could not delete the write journal:', error)
		}
	}

	/**
	 * The user signed out or changed: drop the entries kept for inspection that belong to them.
	 * Entries still waiting for their owner stay, since that user may come back.
	 */
	async purgeFailedOf(owner: string): Promise<void> {
		try {
			const journal = await this.bounded(this.getJournal(), 'open the write journal')
			if (!journal) return
			for (const entry of await this.bounded(journal.list(), 'read the write journal')) {
				if (entry.seq !== undefined && entry.owner === owner && entry.failed !== undefined) {
					await this.bounded(journal.remove(entry.seq), 'forget a failed write')
				}
			}
		} catch (error) {
			console.warn('[kora] Could not clear the failed writes of the previous user:', error)
		}
	}

	/** The signed-in user was looked up again: when it is a different one, clear the previous user's failed writes. */
	async noteSignedInUser(next: string | null): Promise<void> {
		const previous = this.knownOwner?.owner ?? null
		if (previous !== null && previous !== next) {
			this.knownOwner = null
			await this.purgeFailedOf(previous)
		}
	}

	/** Let go of the IndexedDB connection once nothing needs it (it blocks `deleteDatabase` otherwise). */
	private async releaseJournal(): Promise<void> {
		await this.settled()
		const open = this.journalPromise ? await this.journalPromise.catch(() => null) : null
		open?.close()
		this.journalPromise = null
		this.scanned = null
	}

	private async run(
		store: WriteTarget,
		write: {
			collection: string
			kind: JournaledWriteKind
			args: unknown[]
			options?: WriteOptions | undefined
			recordId?: string | undefined
			recordIds?: string[] | undefined
			writtenAt?: number | undefined
		},
		observer: WriteObserver | null,
	): Promise<unknown> {
		const accessor = store.collection(write.collection)
		const args = write.args
		// The ids and the time travel under a symbol key, outside the public `WriteOptions`.
		const options: WriteOptions = {
			...write.options,
			[FIXED_WRITE_KEY]: {
				...(write.recordId !== undefined ? { recordId: write.recordId } : {}),
				...(write.recordIds !== undefined ? { recordIds: write.recordIds } : {}),
				...(write.writtenAt !== undefined ? { writtenAt: write.writtenAt } : {}),
			},
		} as WriteOptions
		return runWithWriteObserver(observer, () => {
			switch (write.kind) {
				case 'insert':
					return accessor.insert(args[0] as Record<string, unknown>, options)
				case 'insertMany':
					return accessor.insertMany(args[0] as Record<string, unknown>[], options)
				case 'update':
					return accessor.update(args[0] as string, args[1] as Record<string, unknown>, options)
				case 'delete':
					return accessor.delete(args[0] as string, options)
			}
		})
	}

	/**
	 * Replay one journal entry onto the open store, unless the operation log shows it already
	 * happened or was overtaken. Never creates a second record, never resurrects a deleted
	 * one, never overwrites a newer edit.
	 */
	private async replay(store: WriteTarget, entry: JournalEntry): Promise<ReplayOutcome> {
		const writtenAt = entry.writtenAt ?? entry.at
		const write = {
			collection: entry.collection,
			kind: entry.kind,
			args: entry.args,
			...(entry.options ? { options: entry.options } : {}),
			recordId: entry.recordId,
			recordIds: entry.recordIds,
			writtenAt,
		}
		const target = entry.kind === 'insert' ? entry.recordId : entry.kind === 'insertMany' ? entry.recordIds?.[0] : targetRecordId(entry.kind, entry.args)
		if (target !== undefined) {
			const history = await this.historyOf(store, entry.collection, target)
			if (entry.kind === 'insert' || entry.kind === 'insertMany') {
				// Any operation, a tombstone included, means the record's story already started.
				if (history.length > 0) return 'skipped'
			} else {
				if (history.length === 0) return 'skipped'
				if (entry.kind === 'delete' && history.some((op) => op.type === 'delete')) return 'skipped'
				const own = store.getNodeId?.()
				// Another device wrote the record after the user acted: replaying with a fresh
				// timestamp would overwrite it, where last-write-wins keeps the newer edit.
				if (history.some((op) => op.nodeId !== own && op.timestamp.wallTime > writtenAt)) {
					return 'skipped'
				}
				// A pass that died after marking the entry stopped somewhere between applying and
				// forgetting it; an operation of this device after that mark is the write itself.
				if (
					entry.applyingAt !== undefined &&
					history.some((op) => op.nodeId === own && op.timestamp.wallTime >= (entry.applyingAt ?? 0))
				) {
					return 'skipped'
				}
			}
		}
		try {
			await this.run(store, write, null)
			return 'applied'
		} catch (error) {
			// The record was removed meanwhile: the update or delete has nothing left to do.
			if (
				(entry.kind === 'update' || entry.kind === 'delete') &&
				(error as { code?: unknown } | null)?.code === 'RECORD_NOT_FOUND'
			) {
				return 'skipped'
			}
			throw error
		}
	}

	private async historyOf(
		store: WriteTarget,
		collection: string,
		recordId: string,
	): Promise<Array<{ type: string; nodeId: string; timestamp: { wallTime: number } }>> {
		if (store.getOperationsForRecord) return store.getOperationsForRecord(collection, recordId)
		// A target without the log can only tell whether the record is live.
		const live = await store.collection(collection).findById(recordId)
		return live === null ? [] : [{ type: 'insert', nodeId: '', timestamp: { wallTime: 0 } }]
	}

	/** Why a write cannot be saved to the journal, or null when it can. */
	private memoryOnlyReason(item: Pending): JournalMemoryOnlyEvent['reason'] | null {
		if (containsAtomicOp(item.args)) return 'atomic-operation'
		if (containsBinary(item.args)) return 'binary-value'
		return this.options.journalBlock?.(item.collection) ?? null
	}

	/** Save a write to the journal; null when it cannot or must not be saved. */
	private persist(item: Pending): Promise<number | null> {
		const reason = this.memoryOnlyReason(item)
		if (reason !== null) {
			this.noteMemoryOnly(item, reason)
			return Promise.resolve(null)
		}
		return (async () => {
			try {
				const journal = await this.bounded(this.getJournal(), 'open the write journal')
				if (!journal) {
					this.noteMemoryOnly(item, 'no-storage')
					return null
				}
				await this.bounded(this.holdSessionLock(), 'take the session lock')
				const known = this.knownOwner
				const entry: JournalEntry = {
					session: this.session,
					owner: known?.owner ?? null,
					...(known === null && this.options.resolveOwner ? { ownerPending: true } : {}),
					at: item.writtenAt,
					collection: item.collection,
					kind: item.kind,
					args: item.args,
					...(item.recordId !== undefined ? { recordId: item.recordId } : {}),
					...(item.recordIds !== undefined ? { recordIds: item.recordIds } : {}),
					writtenAt: item.writtenAt,
					...(item.options?.durable !== undefined
						? { options: { durable: item.options.durable } }
						: {}),
				}
				const seq = Number(await this.bounded(journal.append(entry), 'save the write'))
				if (entry.ownerPending) this.track(this.settleOwner(journal, seq))
				return seq
			} catch (error) {
				this.warnOnce(error)
				this.noteMemoryOnly(item, isTimeout(error) ? 'journal-timeout' : 'journal-error')
				return null
			}
		})()
	}

	/** Patch the owner onto an entry that was saved before the signed-in user was known. */
	private async settleOwner(journal: WriteJournal, seq: number): Promise<void> {
		const answer = await this.resolveOwner()
		if (answer === null) return
		try {
			await this.bounded(journal.update(seq, { owner: answer.owner, ownerPending: false }), 'record the owner')
		} catch (error) {
			this.warnOnce(error)
		}
	}

	/** The signed-in user, or null while the app cannot tell (never a remembered timeout). */
	private async resolveOwner(): Promise<{ owner: string | null } | null> {
		if (this.knownOwner) return this.knownOwner
		const resolve = this.options.resolveOwner
		if (!resolve) return { owner: null }
		try {
			const value = await withTimeout(
				resolve(),
				this.options.ownerTimeoutMs ?? DEFAULT_OWNER_TIMEOUT_MS,
				'find the signed-in user',
			)
			if (typeof value === 'string' && value !== '') this.knownOwner = { owner: value }
			// Signed out is an answer for this entry, but not for the session: a sign-in may follow.
			return { owner: typeof value === 'string' && value !== '' ? value : null }
		} catch {
			return null
		}
	}

	private noteMemoryOnly(item: Pending, reason: JournalMemoryOnlyEvent['reason']): void {
		item.memoryOnly = true
		const pending = this.pending.filter((other) => other.memoryOnly).length + (this.pending.includes(item) ? 0 : 1)
		this.options.emit?.({
			type: 'journal:memory-only',
			dbName: this.options.dbName,
			collection: item.collection,
			kind: item.kind,
			reason,
			pending,
		})
		if (!this.warnedReasons.has(reason)) {
			this.warnedReasons.add(reason)
			console.warn(
				`[kora] A write to "${item.collection}" made before the store opened is held in memory only (${reason}): it is applied when the store opens, but closing the page first would lose it.`,
			)
		}
	}

	private async forget(item: Pending): Promise<void> {
		const seq = await item.appended
		if (seq === null) return
		try {
			const journal = await this.bounded(this.getJournal(), 'open the write journal')
			if (!journal) return
			await this.bounded(journal.remove(seq), 'forget the applied write')
		} catch (error) {
			// The write is applied; a leftover entry is recognised by its record's history and skipped.
			console.error(
				'[kora] A write queued before the store opened was applied, but its journal entry could not be removed; the next start recognises it and skips it:',
				error,
			)
		}
	}

	private track(work: Promise<void>): void {
		this.settling.add(work)
		const done = (): void => {
			this.settling.delete(work)
		}
		work.then(done, done)
	}

	/**
	 * Apply the entries other, closed sessions left in the journal. A failure here never blocks
	 * the drain: the session's own writes still reach the store and `ready` still resolves, and
	 * a pass that runs past its budget stops where it is. Returns the records whose older
	 * writes are still waiting. The recovery logic loads only when there is something to recover.
	 */
	private async recover(store: WriteTarget): Promise<ReadonlySet<string>> {
		try {
			const journal = await this.bounded(this.getJournal(), 'open the write journal')
			if (!journal) return new Set()
			this.scan()
			const entries = (await this.scanned) ?? []
			if (!entries.some((entry) => entry.session !== this.session)) return new Set()
			const { recoverJournal } = await import('./pre-ready-recovery')
			const owner = await this.resolveOwner()
			return await recoverJournal({
				journal,
				locks: this.locks,
				dbName: this.options.dbName,
				session: this.session,
				now: this.now,
				owner: owner === null ? undefined : owner.owner,
				namespacedByUser: this.options.namespacedByUser === true,
				budgetMs: this.options.recoveryBudgetMs ?? DEFAULT_RECOVERY_BUDGET_MS,
				callTimeoutMs: this.journalTimeout,
				apply: (entry) => this.replay(store, entry),
				onUnreadable: (error) => this.warnRecovery(error),
				emit: (event) => this.options.emit?.(event),
			})
		} catch (error) {
			this.warnRecovery(error)
			return new Set()
		}
	}

	/** Mark this session alive for as long as the page lives, so other tabs leave its entries alone. */
	private holdSessionLock(): Promise<void> {
		const locks = this.locks
		if (!locks) return Promise.resolve()
		this.sessionLock ??= new Promise<void>((resolve) => {
			locks
				.request(`${SESSION_LOCK_PREFIX}${this.session}`, { mode: 'exclusive' }, () => {
					resolve()
					return new Promise<void>((release) => {
						this.releaseSessionLock = release
					})
				})
				.catch(() => resolve())
		})
		return this.sessionLock
	}

	/**
	 * Writes held in memory only are lost with the page. IndexedDB cannot be written
	 * synchronously while the page hides, so the one thing to do is not stay silent about it.
	 */
	private watchPageHide(): void {
		if (this.detachPageHide || typeof addEventListener !== 'function') return
		const onHide = (): void => {
			const lost = this.memoryOnlyCount
			if (lost === 0) return
			console.warn(
				`[kora] ${lost} write${lost === 1 ? '' : 's'} made before the store opened ${lost === 1 ? 'is' : 'are'} held in memory only and will be lost: the page is closing.`,
			)
		}
		addEventListener('pagehide', onHide)
		this.detachPageHide = () => removeEventListener('pagehide', onHide)
	}

	private unwatchPageHide(): void {
		this.detachPageHide?.()
		this.detachPageHide = null
	}

	private warnOnce(error: unknown): void {
		if (this.warned) return
		this.warned = true
		console.warn(
			'[kora] Could not save a write made before the store opened to the write journal. It is kept in memory and applied when the store opens, but closing the tab first would lose it:',
			error,
		)
	}

	private warnRecovery(error: unknown): void {
		console.warn(
			'[kora] Could not recover the writes a closed tab left in the write journal; they stay there and the app opens without them:',
			error,
		)
	}
}

/** The record an update or delete addresses (its first argument). */
function targetRecordId(kind: JournaledWriteKind, args: unknown[]): string | undefined {
	if (kind !== 'update' && kind !== 'delete') return undefined
	return typeof args[0] === 'string' ? args[0] : undefined
}

/** Key of a record in a set of unresolved records. */
export function recordKey(collection: string, recordId: string): string {
	return `${collection}\u0000${recordId}`
}

/** A timeout raised by {@link withTimeout}. */
class JournalTimeoutError extends KoraError {
	constructor(what: string, ms: number) {
		super(`Could not ${what} within ${ms} ms.`, 'JOURNAL_TIMEOUT', {
			fix: 'The write stays in memory and is applied when the store opens.',
		})
		this.name = 'JournalTimeoutError'
	}
}

export function isTimeout(error: unknown): boolean {
	return error instanceof JournalTimeoutError
}

/** Reject if `work` does not settle within `ms`; the timer never outlives the work. */
export function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new JournalTimeoutError(what, ms)), ms)
		work.then(
			(value) => {
				clearTimeout(timer)
				resolve(value)
			},
			(error: unknown) => {
				clearTimeout(timer)
				reject(error)
			},
		)
	})
}

/** Fix the ids an insert will get, so a replay finds the record it already made. */
function assignRecordIds(
	kind: JournaledWriteKind,
	args: unknown[],
): { recordId: string | undefined; recordIds: string[] | undefined } {
	if (kind === 'insert') return { recordId: generateUUIDv7(), recordIds: undefined }
	if (kind === 'insertMany') {
		const rows = Array.isArray(args[0]) ? args[0] : []
		return { recordId: undefined, recordIds: rows.map(() => generateUUIDv7()) }
	}
	return { recordId: undefined, recordIds: undefined }
}

/** Whether any argument holds an atomic helper sentinel (`op.increment`, ...) one level deep. */
function containsAtomicOp(args: unknown[]): boolean {
	const check = (value: unknown): boolean => {
		if (isAtomicOp(value)) return true
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
		return Object.values(value).some(isAtomicOp)
	}
	return args.some((arg) => (Array.isArray(arg) ? arg.some(check) : check(arg)))
}

/**
 * Whether any field value is a file or a binary buffer (one level deep). Cloning those into
 * IndexedDB would copy a large payload on every keystroke-speed write, and a blob is the
 * blob store's business, not the journal's.
 */
function containsBinary(args: unknown[]): boolean {
	const isBinary = (value: unknown): boolean =>
		(typeof Blob !== 'undefined' && value instanceof Blob) ||
		value instanceof ArrayBuffer ||
		ArrayBuffer.isView(value)
	const check = (value: unknown): boolean => {
		if (isBinary(value)) return true
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
		return Object.values(value).some(isBinary)
	}
	return args.some((arg) => (Array.isArray(arg) ? arg.some(check) : check(arg)))
}

function randomSession(): string {
	const crypto = globalThis.crypto
	return typeof crypto?.randomUUID === 'function'
		? crypto.randomUUID()
		: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function defaultLocks(): LockManagerLike | null {
	const locks = (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks
	return locks ?? null
}

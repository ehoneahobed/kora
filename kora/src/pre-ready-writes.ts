import {
	KoraError,
	currentWriteObserver,
	generateUUIDv7,
	isAtomicOp,
	runWithWriteObserver,
} from '@korajs/core/lite'
import type { WriteObserver } from '@korajs/core/lite'
import type { WriteOptions } from '@korajs/store'
import type { HeldNodeInfo } from '@korajs/sync'
import type { JournalEntry, JournaledWriteKind, WriteJournal } from './write-journal'

/** The slice of the store a replay needs; `Store` satisfies it. */
export interface WriteTarget {
	/** This device's node id: operations of other nodes are other devices' (or tabs') edits. */
	getNodeId?(): string
	/**
	 * Every operation for a record, tombstones included: a replay of an update or delete uses
	 * it to leave alone what a later operation (this device's other tabs included) rewrote.
	 */
	getOperationsForRecord?(collection: string, recordId: string): Promise<RecordOperation[]>
	/** Whether the journaled write with this key already reached the store (same-transaction record). */
	hasJournalApplied?(opKey: string): Promise<boolean>
	/** Forget keys whose journal entries are gone, and keys older than `olderThanMs`. */
	forgetJournalApplied?(opKeys: readonly string[], olderThanMs?: number): Promise<void>
	collection(name: string): {
		insert(data: Record<string, unknown>, options?: WriteOptions): Promise<unknown>
		insertMany(rows: readonly Record<string, unknown>[], options?: WriteOptions): Promise<unknown>
		update(id: string, data: Record<string, unknown>, options?: WriteOptions): Promise<unknown>
		delete(id: string, options?: WriteOptions): Promise<void>
		findById(id: string): Promise<unknown>
	}
}

/** The part of a stored operation a replay reads. */
export interface RecordOperation {
	type: string
	nodeId: string
	timestamp: { wallTime: number }
	data?: Record<string, unknown> | null
}

/**
 * What the app can say about who is signed in: a user id, nobody (`null` or `undefined`), or
 * `{ loading: true }` while it cannot tell yet. Loading is NOT signed out: it is never settled
 * on an entry and never remembered.
 */
export type OwnerAnswer = string | null | undefined | { loading: true }

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
	resolveOwner?: () => Promise<OwnerAnswer>
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
	emit?: (
		event:
			| JournalFailureEvent
			| JournalMemoryOnlyEvent
			| JournalDiscardedEvent
			| JournalExpiredEvent,
	) => void
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

/** Unsent writes were thrown away with the database they were meant for. */
export interface JournalDiscardedEvent {
	type: 'journal:discarded'
	dbName: string
	count: number
}

/** Failed entries kept for inspection are about to be removed after their grace period. */
export interface JournalExpiredEvent {
	type: 'journal:write-expired'
	dbName: string
	count: number
	entries: Array<{ collection: string; kind: string; owner: string | null }>
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

const DEFAULT_JOURNAL_TIMEOUT_MS = 2000
/** How long a record of an applied journal write is kept: far past any entry that could still need it. */
export const APPLIED_KEY_TTL_MS = 90 * 24 * 60 * 60 * 1000

export interface Pending {
	collection: string
	kind: JournaledWriteKind
	args: unknown[]
	options: WriteOptions | undefined
	observer: WriteObserver | null
	/** Identity of the write, see {@link JournalEntry.opKey}. */
	opKey: string
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
	/** @internal */
	journalPromise: Promise<WriteJournal | null> | null = null
	/** @internal */
	readonly journalOverride: WriteJournal | null | undefined
	/** @internal */
	readonly locks: LockManagerLike | null
	/** @internal */
	readonly session: string
	/** @internal */
	readonly now: () => number
	private readonly pending: Pending[] = []
	/** @internal */
	store: WriteTarget | null = null
	private draining = false
	private failure: KoraError | null = null
	/** The signed-in user once the app said who it is (a timeout is never remembered). */
	/** @internal */
	knownOwner: { owner: string | null } | null = null
	/** The user the app last reported (baseline for noticing a sign-out or a change). */
	/** @internal */
	lastUser: string | null | undefined = undefined
	/** Entries saved before the user was known, waiting for the first definite answer. */
	/** @internal */
	readonly ownerWaiters = new Set<number>()
	/** @internal */
	sessionLock: Promise<void> | null = null
	/** @internal */
	releaseSessionLock: (() => void) | null = null
	/** @internal */
	scanned: Promise<JournalEntry[]> | null = null
	private warned = false
	private readonly warnedReasons = new Set<string>()
	/** Journal bookkeeping still running (removing applied entries, patching owners). */
	private readonly settling = new Set<Promise<void>>()
	private detachPageHide: (() => void) | null = null

	constructor(readonly options: PreReadyWriteQueueOptions) {
		this.journalOverride = options.journal
		this.locks = options.locks === undefined ? defaultLocks() : options.locks
		this.session = options.session ?? randomSession()
		this.now = options.now ?? Date.now
	}

	/** @internal */
	get journalTimeout(): number {
		return this.options.journalTimeoutMs ?? DEFAULT_JOURNAL_TIMEOUT_MS
	}

	/** Bound a journal call: past the limit the journal is treated as not answering. */
	/** @internal */
	bounded<T>(work: Promise<T>, what: string): Promise<T> {
		return withTimeout(work, this.journalTimeout, what)
	}

	/** @internal */
	getJournal(): Promise<WriteJournal | null> {
		this.journalPromise ??= import('./pre-ready-journal').then((m) => m.openJournal(this))
		return this.journalPromise
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

	/** Journal writes waiting for their owner, as held nodes (see `describeHeld`). */
	heldNodes: readonly HeldNodeInfo[] = []
	/** @internal Read by the held-writes operations in `pre-ready-recovery`. */
	heldEntries: JournalEntry[] = []
	private readonly changeListeners = new Set<() => void>()

	/** Listen for a change of {@link size} or {@link heldNodes} (feeds the sync status). */
	onChange(listener: () => void): () => void {
		this.changeListeners.add(listener)
		return () => this.changeListeners.delete(listener)
	}

	private changed(): void {
		for (const listener of [...this.changeListeners]) listener()
	}

	/** @internal */
	setHeld(entries: JournalEntry[], nodes: HeldNodeInfo[]): void {
		this.heldEntries = entries
		this.heldNodes = nodes
		this.changed()
	}

	/**
	 * Apply the held writes of one node into the signed-in user (`app.sync.assignHeld`), or throw
	 * a `SyncError` with a code saying why they cannot be.
	 */
	async assignHeld(nodeId: string): Promise<void> {
		await (await import('./pre-ready-recovery')).assignHeldNode(this, nodeId)
	}

	/** Remove the held writes of one node for good (`app.sync.discardHeld`); returns how many. */
	async discardHeld(nodeId: string): Promise<number> {
		return (await import('./pre-ready-recovery')).discardHeldNode(this, nodeId)
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
			// After the drain the store is open: the write goes straight in, with no journal entry
			// and so no key to record.
			return this.run(this.store, { collection, kind, args, options, ...ids, writtenAt }, observer)
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
				opKey: generateUUIDv7(),
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
			this.changed()
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
			this.changed()
			if (held.size > 0) {
				// Loaded only when a recovery left writes waiting.
				const { blockedByOlderWrite } = await import('./pre-ready-recovery')
				if (await blockedByOlderWrite(item, held)) continue
			}
			try {
				item.resolve(await this.run(store, item, item.observer))
			} catch (error) {
				item.reject(error)
			}
			this.track(import('./pre-ready-journal').then((m) => m.forgetApplied(this, item, store)))
		}
		// No await between the empty check above and this line: a write cannot slip into the
		// queue after the drain ended and be left behind.
		this.store = store
		this.draining = false
		this.unwatchPageHide()
		// Keys of long-gone entries are pruned on every start, whether or not a recovery ran.
		this.track(
			this.bounded(
				Promise.resolve(store.forgetJournalApplied?.([], APPLIED_KEY_TTL_MS)),
				'prune the applied-write keys',
			).then(
				() => {},
				() => {},
			),
		)
		// The journal has nothing more to do this session; the connection must not block a wipe.
		void this.releaseJournal().catch(() => {})
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
		if (items.length > 0) {
			const saved = await Promise.all(items.map((item) => item.appended))
			const { rejectUnapplied } = await import('./pre-ready-recovery')
			await rejectUnapplied(items, saved, why, cause)
		}
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
	async discardJournal(name: string = this.options.dbName): Promise<void> {
		const { discardJournalFor } = await import('./pre-ready-recovery')
		await discardJournalFor(this, this.options.dbName, name)
	}

	/**
	 * The user signed out or changed: drop the entries kept for inspection that belong to them.
	 * Entries still waiting for their owner stay, since that user may come back.
	 */
	async purgeFailedOf(owner: string): Promise<void> {
		const { purgeFailedOf } = await import('./pre-ready-recovery')
		await purgeFailedOf(this, owner)
	}

	/**
	 * The app reported the signed-in user (`null`: nobody). Entries still waiting for their owner
	 * learn it, and when the user changed, the failed writes kept for the previous one are
	 * cleared. The first report is the baseline, so a session that starts signed in still
	 * notices the sign-out.
	 */
	async noteSignedInUser(next: string | null): Promise<void> {
		await (await import('./pre-ready-recovery')).noteSignedInUserOf(this, next)
	}

	/** Let go of the IndexedDB connection once nothing needs it (it blocks `deleteDatabase` otherwise). */
	/** @internal */
	async releaseJournal(): Promise<void> {
		await this.settled()
		const open = this.journalPromise ? await this.journalPromise.catch(() => null) : null
		open?.close()
		this.journalPromise = null
		this.scanned = null
	}

	/** @internal */
	async run(
		store: WriteTarget,
		write: {
			collection: string
			kind: JournaledWriteKind
			args: unknown[]
			options?: WriteOptions | undefined
			recordId?: string | undefined
			recordIds?: string[] | undefined
			writtenAt?: number | undefined
			opKey?: string | undefined
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
				...(write.opKey !== undefined ? { opKey: write.opKey } : {}),
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
		return import('./pre-ready-journal').then(
			(m) => m.saveEntry(this, item),
			(error: unknown) => {
				this.warnOnce(error)
				this.noteMemoryOnly(item, 'journal-error')
				return null
			},
		)
	}

	/** @internal */
	async patchOwner(journal: WriteJournal, seq: number, owner: string | null): Promise<void> {
		await (await import('./pre-ready-journal')).patchOwner(this, journal, seq, owner)
	}

	/** @internal */
	noteMemoryOnly(item: Pending, reason: JournalMemoryOnlyEvent['reason']): void {
		item.memoryOnly = true
		const pending =
			this.pending.filter((other) => other.memoryOnly).length +
			(this.pending.includes(item) ? 0 : 1)
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
			this.warnLater('memory-only', item.collection, reason)
		}
	}

	private async recover(store: WriteTarget): Promise<ReadonlySet<string>> {
		try {
			return await (await import('./pre-ready-journal')).recover(this, store)
		} catch (error) {
			this.warnRecovery(error)
			return new Set()
		}
	}

	/** @internal */
	track(work: Promise<void>): void {
		this.settling.add(work)
		const done = (): void => {
			this.settling.delete(work)
		}
		work.then(done, done)
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
				`[kora] ${lost} write(s) made before the store opened are held in memory only and will be lost: the page is closing.`,
			)
		}
		addEventListener('pagehide', onHide)
		this.detachPageHide = () => removeEventListener('pagehide', onHide)
	}

	private unwatchPageHide(): void {
		this.detachPageHide?.()
		this.detachPageHide = null
	}

	/** @internal */
	warnOnce(error: unknown): void {
		if (this.warned) return
		this.warned = true
		this.warnLater('save', error)
	}

	/** @internal */
	warnRecovery(error: unknown): void {
		this.warnLater('recovery', error)
	}

	/** The console texts live in the lazily loaded module: they are never needed for a first paint. */
	private warnLater(kind: 'memory-only' | 'save' | 'recovery', ...details: unknown[]): void {
		void import('./pre-ready-recovery').then(({ warnJournal }) => warnJournal(kind, ...details))
	}
}

/** The record an update or delete addresses (its first argument). */
export function targetRecordId(kind: JournaledWriteKind, args: unknown[]): string | undefined {
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

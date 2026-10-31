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
	collection(name: string): {
		insert(data: Record<string, unknown>, options?: WriteOptions): Promise<unknown>
		insertMany(rows: readonly Record<string, unknown>[], options?: WriteOptions): Promise<unknown>
		update(id: string, data: Record<string, unknown>, options?: WriteOptions): Promise<unknown>
		delete(id: string, options?: WriteOptions): Promise<void>
		findById(id: string): Promise<unknown>
	}
}

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
	 * Whether writes to a collection may be saved to the journal. The journal holds the
	 * arguments as the caller gave them, before the store's at-rest transform (secret fields,
	 * end-to-end encryption) could run, so a collection that needs that transform stays in
	 * memory only. Defaults to every collection.
	 */
	canJournal?: (collection: string) => boolean
	/** How long to wait for the signed-in user before treating it as unknown. Default 3000. */
	ownerTimeoutMs?: number
	/** Receives `journal:write-failed` events. */
	emit?: (event: JournalFailureEvent) => void
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
}

/**
 * Writes made through a framework hook before the store opened.
 *
 * Each write is held in memory (its promise resolves when it has been applied to the open
 * store, in call order) and saved to the {@link WriteJournal} first, so closing the tab
 * before the store opens does not lose it: the next session that opens the same database
 * applies it ({@link PreReadyWriteQueue.apply}).
 *
 * Exactly-once: the record id of an insert and the time of the write are fixed when the
 * user acts and stored with the entry, and a replay of an insert whose record already exists
 * does nothing, so a process that dies between applying a write and removing its entry
 * applies it once, not twice. Updates and deletes are idempotent by their record id.
 *
 * Memory only (they wait for the store but do not survive a closed tab): writes that use
 * atomic helpers (`op.increment`, ...), which hold symbols that cannot be saved and would be
 * wrong to apply twice, and writes to a collection `canJournal` refuses (secret fields,
 * end-to-end encryption: the journal would hold plaintext).
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
	private ownerPromise: Promise<string | null> | null = null
	private sessionLock: Promise<void> | null = null
	private scanned: Promise<JournalEntry[]> | null = null
	private warned = false

	constructor(private readonly options: PreReadyWriteQueueOptions) {
		this.journalOverride = options.journal
		this.locks = options.locks === undefined ? defaultLocks() : options.locks
		this.session = options.session ?? randomSession()
		this.now = options.now ?? Date.now
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

	/**
	 * Whether a write made now, outside a hook's synchronous part, still belongs to the queue:
	 * the store is being drained or just finished. A mutation that awaits one write and then
	 * makes another (`await a.insert(); await b.insert()`) is in this window for its second
	 * write, and must not be refused halfway.
	 */
	get acceptsDirectWrites(): boolean {
		return this.draining || this.store !== null
	}

	/**
	 * Start reading the journal now, while the store is still opening, so the recovery step
	 * before `ready` finds the answer already there (an empty journal costs nothing then).
	 */
	scan(): void {
		if (this.scanned) return
		this.scanned = this.getJournal()
			.then((journal) => journal?.list() ?? [])
			.catch((error: unknown) => {
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
				true,
			)
		}
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
			}
			item.appended = this.persist(item)
			this.pending.push(item)
		})
	}

	/**
	 * Apply what a closed tab left behind, then every write queued in this session, in order,
	 * and from then on pass writes straight to the store. Called once, as the last step
	 * before `app.ready` resolves.
	 */
	async apply(store: WriteTarget): Promise<void> {
		this.draining = true
		await this.recover(store)
		while (this.pending.length > 0) {
			const item = this.pending.shift()
			if (!item) break
			try {
				item.resolve(await this.run(store, item, item.observer, true))
			} catch (error) {
				item.reject(error)
			}
			await this.forget(item)
		}
		// No await between the empty check above and this line: a write cannot slip into the
		// queue after the drain ended and be left behind.
		this.store = store
		this.draining = false
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
		fresh: boolean,
	): Promise<unknown> {
		const accessor = store.collection(write.collection)
		const args = write.args
		const options: WriteOptions = {
			...write.options,
			...(write.recordId !== undefined ? { recordId: write.recordId } : {}),
			...(write.recordIds !== undefined ? { recordIds: write.recordIds } : {}),
			...(write.writtenAt !== undefined ? { writtenAt: write.writtenAt } : {}),
		}
		// A replay of an insert whose record already exists is the same write done twice.
		if (!fresh) {
			const firstId = write.kind === 'insert' ? write.recordId : write.recordIds?.[0]
			if (firstId !== undefined && (await accessor.findById(firstId)) !== null) return undefined
		}
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

	/** Save a write to the journal; null when it cannot or must not be saved. */
	private persist(item: Pending): Promise<number | null> {
		if (containsAtomicOp(item.args)) return Promise.resolve(null)
		if (this.options.canJournal && !this.options.canJournal(item.collection)) {
			return Promise.resolve(null)
		}
		return (async () => {
			try {
				const journal = await this.getJournal()
				if (!journal) return null
				await this.holdSessionLock()
				const entry: JournalEntry = {
					session: this.session,
					owner: await this.owner(),
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
				return await journal.append(entry)
			} catch (error) {
				this.warnOnce(error)
				return null
			}
		})()
	}

	private async forget(item: Pending): Promise<void> {
		const seq = await item.appended
		const journal = seq === null ? null : await this.getJournal()
		if (seq === null || !journal) return
		try {
			await journal.remove(seq)
		} catch (error) {
			// The write is applied; a leftover entry replays as a no-op (its record exists).
			console.error(
				'[kora] A write queued before the store opened was applied, but its journal entry could not be removed; the next start recognises it and skips it:',
				error,
			)
		}
	}

	/**
	 * Apply the entries other, closed sessions left in the journal. A failure here never blocks
	 * the drain: the session's own writes still reach the store and `ready` still resolves.
	 * The recovery logic loads only when there is something to recover.
	 */
	private async recover(store: WriteTarget): Promise<void> {
		try {
			const journal = await this.getJournal()
			if (!journal) return
			this.scan()
			const entries = (await this.scanned) ?? []
			if (!entries.some((entry) => entry.session !== this.session)) return
			const { recoverJournal } = await import('./pre-ready-recovery')
			await recoverJournal({
				journal,
				locks: this.locks,
				dbName: this.options.dbName,
				session: this.session,
				now: this.now,
				owner: () => this.owner(),
				apply: (entry) =>
					this.run(
						store,
						{
							collection: entry.collection,
							kind: entry.kind,
							args: entry.args,
							...(entry.options ? { options: entry.options } : {}),
							recordId: entry.recordId,
							recordIds: entry.recordIds,
							writtenAt: entry.writtenAt ?? entry.at,
						},
						null,
						false,
					),
				onUnreadable: (error) => this.warnRecovery(error),
				emit: (event) => this.options.emit?.(event),
			})
		} catch (error) {
			this.warnRecovery(error)
		}
	}

	private owner(): Promise<string | null> {
		this.ownerPromise ??= (async () => {
			try {
				const resolve = this.options.resolveOwner
				if (!resolve) return null
				const timeout = new Promise<undefined>((done) =>
					setTimeout(() => done(undefined), this.options.ownerTimeoutMs ?? 3000),
				)
				return (await Promise.race([resolve(), timeout])) ?? null
			} catch {
				return null
			}
		})()
		return this.ownerPromise
	}

	/** Mark this session alive for as long as the page lives, so other tabs leave its entries alone. */
	private holdSessionLock(): Promise<void> {
		const locks = this.locks
		if (!locks) return Promise.resolve()
		this.sessionLock ??= new Promise<void>((resolve) => {
			locks
				.request(`${SESSION_LOCK_PREFIX}${this.session}`, { mode: 'exclusive' }, () => {
					resolve()
					return new Promise<never>(() => {})
				})
				.catch(() => resolve())
		})
		return this.sessionLock
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

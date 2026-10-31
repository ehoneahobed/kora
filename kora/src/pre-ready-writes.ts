import { currentWriteObserver, isAtomicOp, runWithWriteObserver } from '@korajs/core/lite'
import type { WriteObserver } from '@korajs/core/lite'
import type { WriteOptions } from '@korajs/store'
import {
	type JournalEntry,
	type JournaledWriteKind,
	type WriteJournal,
	openWriteJournal,
} from './write-journal'

/** The slice of the store a replay needs; `Store` satisfies it. */
export interface WriteTarget {
	collection(name: string): {
		insert(data: Record<string, unknown>, options?: WriteOptions): Promise<unknown>
		insertMany(rows: readonly Record<string, unknown>[], options?: WriteOptions): Promise<unknown>
		update(id: string, data: Record<string, unknown>, options?: WriteOptions): Promise<unknown>
		delete(id: string, options?: WriteOptions): Promise<void>
	}
}

/** The part of the Web Locks API the queue uses. */
export interface LockManagerLike {
	request(
		name: string,
		options: { mode?: 'exclusive' | 'shared' },
		callback: () => Promise<unknown>,
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
}

/** A journal entry of another page session is assumed abandoned after this long without Web Locks. */
const ORPHAN_AFTER_MS = 2 * 60 * 1000
/** An entry for another user that nobody claims is dropped after this long. */
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000
const SESSION_LOCK_PREFIX = 'kora-journal-session:'

interface Pending {
	collection: string
	kind: JournaledWriteKind
	args: unknown[]
	options: WriteOptions | undefined
	observer: WriteObserver | null
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
 * Exactly-once is as strong as the store allows: a write is applied, then its journal entry
 * is removed. A process that dies in the few milliseconds between the two applies the write
 * again at the next start. Writes that use atomic helpers (`op.increment`, ...) hold
 * symbols that cannot be saved, and would be wrong to apply twice, so they are queued in
 * memory only: they wait for the store but do not survive a closed tab.
 */
export class PreReadyWriteQueue {
	private readonly journal: WriteJournal | null
	private readonly locks: LockManagerLike | null
	private readonly session: string
	private readonly now: () => number
	private readonly pending: Pending[] = []
	private store: WriteTarget | null = null
	private ownerPromise: Promise<string | null> | null = null
	private sessionLock: Promise<void> | null = null
	private warned = false

	constructor(private readonly options: PreReadyWriteQueueOptions) {
		this.journal =
			options.journal === undefined ? openWriteJournal(options.dbName) : options.journal
		this.locks = options.locks === undefined ? defaultLocks() : options.locks
		this.session = options.session ?? randomSession()
		this.now = options.now ?? Date.now
	}

	/** Writes held in memory right now. */
	get size(): number {
		return this.pending.length
	}

	/**
	 * Queue a write. Must be called synchronously from the hook's mutation function so the
	 * write observer is still current. Resolves with what the store's method returns.
	 */
	enqueue(
		collection: string,
		kind: JournaledWriteKind,
		args: unknown[],
		options?: WriteOptions,
	): Promise<unknown> {
		const observer = currentWriteObserver()
		if (this.store) return this.run(this.store, { collection, kind, args, options }, observer)
		return new Promise<unknown>((resolve, reject) => {
			const item: Pending = {
				collection,
				kind,
				args,
				options,
				observer,
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
		await this.recover(store)
		while (this.pending.length > 0) {
			const item = this.pending.shift()
			if (!item) break
			try {
				item.resolve(await this.run(store, item, item.observer))
			} catch (error) {
				item.reject(error)
			}
			await this.forget(item)
		}
		// No await between the empty check above and this line: a write cannot slip into the
		// queue after the drain ended and be left behind.
		this.store = store
	}

	/**
	 * The store will not open: fail every waiting write with `error`. Each caller is told its
	 * write did not happen, so its journal entry is dropped too (a refused write is not
	 * applied later).
	 */
	async fail(error: unknown): Promise<void> {
		const items = this.pending.splice(0)
		for (const item of items) {
			item.reject(error)
			await this.forget(item)
		}
	}

	private run(
		store: WriteTarget,
		write: {
			collection: string
			kind: JournaledWriteKind
			args: unknown[]
			options?: WriteOptions | undefined
		},
		observer: WriteObserver | null,
	): Promise<unknown> {
		return runWithWriteObserver(observer, () => {
			const accessor = store.collection(write.collection)
			const args = write.args
			switch (write.kind) {
				case 'insert':
					return accessor.insert(args[0] as Record<string, unknown>, write.options)
				case 'insertMany':
					return accessor.insertMany(args[0] as Record<string, unknown>[], write.options)
				case 'update':
					return accessor.update(
						args[0] as string,
						args[1] as Record<string, unknown>,
						write.options,
					)
				case 'delete':
					return accessor.delete(args[0] as string, write.options)
			}
		})
	}

	/** Save a write to the journal; null when it cannot or must not be saved. */
	private persist(item: Pending): Promise<number | null> {
		const journal = this.journal
		if (!journal) return Promise.resolve(null)
		if (containsAtomicOp(item.args)) return Promise.resolve(null)
		return (async () => {
			try {
				await this.holdSessionLock()
				const entry: JournalEntry = {
					session: this.session,
					owner: await this.owner(),
					at: this.now(),
					collection: item.collection,
					kind: item.kind,
					args: item.args,
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
		if (seq === null || !this.journal) return
		try {
			await this.journal.remove(seq)
		} catch (error) {
			// The write is applied; a leftover entry would apply it again next session.
			console.error(
				'[kora] A write queued before the store opened was applied, but its journal entry could not be removed; it may be applied once more at the next start:',
				error,
			)
		}
	}

	/** Apply the entries other, closed sessions left in the journal. */
	private async recover(store: WriteTarget): Promise<void> {
		const journal = this.journal
		if (!journal) return
		const work = async (): Promise<void> => {
			let entries: JournalEntry[]
			try {
				entries = await journal.list()
			} catch (error) {
				this.warnOnce(error)
				return
			}
			const owner = await this.owner()
			const live = await this.liveSessions()
			for (const entry of entries) {
				if (entry.session === this.session || entry.failed !== undefined) continue
				if (entry.seq === undefined) continue
				const age = this.now() - entry.at
				if (live ? live.has(entry.session) : age < ORPHAN_AFTER_MS) continue
				if (entry.owner !== null && entry.owner !== owner) {
					// Another user's write waits for that user; an unclaimed one is dropped, loudly.
					if (age > STALE_AFTER_MS) {
						console.warn(
							`[kora] Dropping a write to "${entry.collection}" queued ${Math.round(age / 86_400_000)} days ago by another user and never claimed.`,
						)
						await journal.remove(entry.seq).catch(() => {})
					}
					continue
				}
				try {
					await this.run(store, entry, null)
					await journal.remove(entry.seq)
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error)
					console.error(
						`[kora] A write to "${entry.collection}" that a closed tab queued before the store opened could not be applied and is kept in the write journal for inspection: ${message}`,
					)
					await journal.markFailed(entry.seq, message).catch(() => {})
				}
			}
		}
		const locks = this.locks
		if (!locks) return work()
		// One tab recovers at a time, so two tabs opening together never apply an entry twice.
		await locks.request(`kora-journal-drain:${this.options.dbName}`, { mode: 'exclusive' }, work)
	}

	private owner(): Promise<string | null> {
		this.ownerPromise ??= (async () => {
			try {
				return (await this.options.resolveOwner?.()) ?? null
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

	/** The sessions whose page is still open, or null where that cannot be told. */
	private async liveSessions(): Promise<Set<string> | null> {
		if (!this.locks?.query) return null
		try {
			const state = await this.locks.query()
			const live = new Set<string>()
			for (const lock of state.held ?? []) {
				if (lock.name?.startsWith(SESSION_LOCK_PREFIX)) {
					live.add(lock.name.slice(SESSION_LOCK_PREFIX.length))
				}
			}
			return live
		} catch {
			return null
		}
	}

	private warnOnce(error: unknown): void {
		if (this.warned) return
		this.warned = true
		console.warn(
			'[kora] Could not save a write made before the store opened to the write journal. It is kept in memory and applied when the store opens, but closing the tab first would lose it:',
			error,
		)
	}
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

import { recordKey, targetRecordId, withTimeout } from './pre-ready-writes'
import type {
	JournalFailureEvent,
	LockManagerLike,
	ReplayOutcome,
	WriteTarget,
} from './pre-ready-writes'
import type { JournalEntry, WriteJournal } from './write-journal'

/** Prefix of the Web Lock each page session holds while it lives (see `PreReadyWriteQueue`). */
export const SESSION_LOCK_PREFIX = 'kora-journal-session:'
/** A journal entry of another page session is assumed abandoned after this long without Web Locks. */
const ORPHAN_AFTER_MS = 2 * 60 * 1000
/** An entry for another user that nobody claims is dropped after this long. */
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000

/** Transient failures an entry survives before it is given up on and kept for inspection. */
export const MAX_RECOVERY_ATTEMPTS = 5

/** What a recovery pass needs from the queue that runs it. */
export interface RecoveryContext {
	journal: WriteJournal
	locks: LockManagerLike | null
	dbName: string
	/** This page session; its own entries are never recovered. */
	session: string
	now: () => number
	/** The signed-in user (null: nobody), or undefined while the app cannot tell. */
	owner: string | null | undefined
	/** True when each user has a database of their own (an unclaimed write is then held). */
	namespacedByUser: boolean
	/** Longest the pass may run; past it the pass stops and leaves the rest for the next start. */
	budgetMs: number
	/** Longest one journal call may take. */
	callTimeoutMs: number
	/** Apply one entry to the open store, or find that it already happened. */
	apply: (entry: JournalEntry) => Promise<ReplayOutcome>
	/** The journal could not be listed. */
	onUnreadable: (error: unknown) => void
	/** A recovered write could not be applied. */
	emit: (event: JournalFailureEvent) => void
}

/** Codes of errors that say "not now" rather than "never": the entry waits for the next start. */
const TRANSIENT_CODES = new Set([
	'STORAGE_DURABILITY_LOST',
	'WRITE_NOT_DURABLE',
	'STORAGE_IN_USE',
	'WORKER_TIMEOUT',
	'NO_LEADER',
	'LEADER_UNRESPONSIVE',
	'BRIDGE_TERMINATED',
	'REQUEST_ABORTED',
	'TAB_COORDINATION_UNAVAILABLE',
	'VERSION_GATE_CLOSED',
])

/**
 * Whether a failed write is worth trying again at the next start (storage busy, full, not
 * durable). Decided by the error's code or name only: a generic storage error (every failed
 * SQL statement raises one) is a bug in the write, and message text is not evidence.
 */
export function isTransientWriteFailure(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false
	const { code, name } = error as { code?: unknown; name?: unknown }
	if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true
	return name === 'QuotaExceededError' || name === 'TransactionInactiveError'
}

/** Whether `entry` belongs to the user the app has now, is nobody's yet, or is someone else's. */
function claim(entry: JournalEntry, context: RecoveryContext): 'mine' | 'held' | 'theirs' {
	const current = context.owner
	if (current === undefined) return 'held'
	if (typeof entry.owner === 'string') return entry.owner === current ? 'mine' : 'theirs'
	// Saved before the user was known (or while nobody was signed in).
	if (entry.ownerPending !== true) return current === null ? 'mine' : 'theirs'
	if (current === null) return 'mine'
	return context.namespacedByUser ? 'held' : 'mine'
}

/** The records an entry touches, for the ordering guard. */
function entryRecords(entry: JournalEntry): string[] {
	const ids =
		entry.kind === 'insert'
			? [entry.recordId]
			: entry.kind === 'insertMany'
				? (entry.recordIds ?? [])
				: [typeof entry.args[0] === 'string' ? entry.args[0] : undefined]
	return ids
		.filter((id): id is string => id !== undefined)
		.map((id) => recordKey(entry.collection, id))
}

/**
 * Apply the entries other, closed sessions left in the journal, oldest first. Kept apart
 * from the queue so the code only a second visit needs stays out of the first paint
 * (first-visit parity, K3).
 *
 * The pass stops at the first transient failure (a later entry for the same record must not
 * land before an earlier one that is still waiting) and when it runs past its budget. Returns
 * the records whose writes are still waiting, so this session's writes to them can wait too.
 *
 * @param context - The journal, locks and the apply function of the running queue
 * @returns The keys of the records with writes still waiting
 */
export async function recoverJournal(context: RecoveryContext): Promise<ReadonlySet<string>> {
	const { journal } = context
	const held = new Set<string>()
	const call = <T>(work: Promise<T>, what: string): Promise<T> =>
		withTimeout(work, context.callTimeoutMs, what)
	const work = async (): Promise<void> => {
		let entries: JournalEntry[]
		try {
			entries = await call(journal.list(), 'read the write journal')
		} catch (error) {
			context.onUnreadable(error)
			return
		}
		const foreign = entries.filter((entry) => entry.session !== context.session)
		if (foreign.length === 0) return
		const live = await liveSessions(context.locks)
		const started = Date.now()
		let stopped = false
		for (const entry of foreign) {
			if (entry.seq === undefined) continue
			const age = context.now() - entry.at
			if (entry.failed !== undefined) {
				// Kept for inspection, not forever.
				if (age > STALE_AFTER_MS) await journal.remove(entry.seq).catch(() => {})
				continue
			}
			if (live ? live.has(entry.session) : age < ORPHAN_AFTER_MS) continue
			const ownership = claim(entry, context)
			if (ownership === 'theirs') {
				// A write made by another user is not applied into this user's database: it waits
				// for its owner, and is dropped, loudly, if nobody ever comes back for it.
				if (age > STALE_AFTER_MS) {
					console.warn(
						`[kora] Dropping a write to "${entry.collection}" queued ${Math.round(age / 86_400_000)} days ago by another user and never claimed.`,
					)
					await journal.remove(entry.seq).catch(() => {})
				}
				continue
			}
			if (ownership === 'held') {
				// Nobody can be told to own it yet (or this device keeps one database per user and
				// the writer is unknown): it is not applied into a database it may not belong to.
				for (const key of entryRecords(entry)) held.add(key)
				context.emit({
					type: 'journal:write-failed',
					dbName: context.dbName,
					collection: entry.collection,
					kind: entry.kind,
					message:
						'The write was saved before the signed-in user was known and waits for its owner.',
					permanent: false,
				})
				continue
			}
			if (stopped || Date.now() - started > context.budgetMs) {
				if (!stopped) {
					console.warn(
						'[kora] Recovering the writes a closed tab left took longer than its budget; the rest is applied at the next start.',
					)
				}
				stopped = true
				for (const key of entryRecords(entry)) held.add(key)
				continue
			}
			try {
				if (entry.kind === 'update' || entry.kind === 'delete') {
					// A crash after this mark means the write may have reached the store.
					await call(journal.update(entry.seq, { applyingAt: context.now() }), 'mark the write')
				}
				await context.apply(entry)
				await call(journal.remove(entry.seq), 'forget the applied write')
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				const attempts = (entry.attempts ?? 0) + 1
				const transient = isTransientWriteFailure(error)
				const permanent = !transient || attempts >= MAX_RECOVERY_ATTEMPTS
				console.error(
					permanent
						? `[kora] A write to "${entry.collection}" that a closed tab queued before the store opened could not be applied and is kept in the write journal for inspection: ${message}`
						: `[kora] A write to "${entry.collection}" that a closed tab queued before the store opened could not be applied now and is tried again at the next start: ${message}`,
				)
				context.emit({
					type: 'journal:write-failed',
					dbName: context.dbName,
					collection: entry.collection,
					kind: entry.kind,
					message,
					permanent,
				})
				if (permanent) {
					await journal.markFailed(entry.seq, message).catch(() => {})
				} else {
					await journal.update(entry.seq, { attempts }).catch(() => {})
					// Order matters on one record: nothing after this entry is applied this start.
					stopped = true
					for (const key of entryRecords(entry)) held.add(key)
				}
			}
		}
	}
	const locks = context.locks
	if (!locks) {
		await work()
		return held
	}
	// One tab recovers at a time, so two tabs opening together never apply an entry twice.
	// A tab that finds the lock taken skips: the other one is doing the work, and waiting
	// here would hold `app.ready` behind it.
	await locks.request(
		`kora-journal-drain:${context.dbName}`,
		{ mode: 'exclusive', ifAvailable: true },
		async (lock) => {
			if (lock === null) return
			await work()
		},
	)
	return held
}

/** The sessions whose page is still open, or null where that cannot be told. */
async function liveSessions(locks: LockManagerLike | null): Promise<Set<string> | null> {
	if (!locks?.query) return null
	try {
		const state = await locks.query()
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

/** The write a replay hands back to the queue to apply. */
export interface ReplayWrite {
	collection: string
	kind: JournalEntry['kind']
	args: unknown[]
	options?: JournalEntry['options']
	recordId: string | undefined
	recordIds: string[] | undefined
	writtenAt: number
}

/**
 * Replay one journal entry onto the open store, unless the operation log shows it already
 * happened or was overtaken. Never creates a second record, never resurrects a deleted
 * one, never overwrites a newer edit.
 *
 * @param store - The open store
 * @param entry - The journal entry to replay
 * @param run - Applies a write to the store (the queue's own, so the same options are used)
 * @returns Whether the entry was applied or found already done
 */
export async function replayEntry(
	store: WriteTarget,
	entry: JournalEntry,
	run: (write: ReplayWrite) => Promise<unknown>,
): Promise<ReplayOutcome> {
	const writtenAt = entry.writtenAt ?? entry.at
	const write: ReplayWrite = {
		collection: entry.collection,
		kind: entry.kind,
		args: entry.args,
		...(entry.options ? { options: entry.options } : {}),
		recordId: entry.recordId,
		recordIds: entry.recordIds,
		writtenAt,
	}
	const target =
		entry.kind === 'insert'
			? entry.recordId
			: entry.kind === 'insertMany'
				? entry.recordIds?.[0]
				: targetRecordId(entry.kind, entry.args)
	if (target !== undefined) {
		const history = await historyOf(store, entry.collection, target)
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
		await run(write)
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

async function historyOf(
	store: WriteTarget,
	collection: string,
	recordId: string,
): Promise<Array<{ type: string; nodeId: string; timestamp: { wallTime: number } }>> {
	if (store.getOperationsForRecord) return store.getOperationsForRecord(collection, recordId)
	// A target without the log can only tell whether the record is live.
	const live = await store.collection(collection).findById(recordId)
	return live === null ? [] : [{ type: 'insert', nodeId: '', timestamp: { wallTime: 0 } }]
}

/**
 * Remove the entries kept for inspection (failed) that belong to `owner`. Entries still
 * waiting for their owner stay.
 *
 * @param journal - The journal
 * @param owner - The user who signed out or was replaced
 * @param call - Bounds a journal call in time
 */
export async function purgeFailedEntries(
	journal: WriteJournal,
	owner: string,
	call: <T>(work: Promise<T>, what: string) => Promise<T>,
): Promise<void> {
	for (const entry of await call(journal.list(), 'read the write journal')) {
		if (entry.seq !== undefined && entry.owner === owner && entry.failed !== undefined) {
			await call(journal.remove(entry.seq), 'forget a failed write')
		}
	}
}

import type { JournalFailureEvent, LockManagerLike } from './pre-ready-writes'
import type { JournalEntry, WriteJournal } from './write-journal'

/** Prefix of the Web Lock each page session holds while it lives (see `PreReadyWriteQueue`). */
export const SESSION_LOCK_PREFIX = 'kora-journal-session:'
/** A journal entry of another page session is assumed abandoned after this long without Web Locks. */
const ORPHAN_AFTER_MS = 2 * 60 * 1000
/** An entry for another user that nobody claims is dropped after this long. */
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000

/** What a recovery pass needs from the queue that runs it. */
export interface RecoveryContext {
	journal: WriteJournal
	locks: LockManagerLike | null
	dbName: string
	/** This page session; its own entries are never recovered. */
	session: string
	now: () => number
	owner: () => Promise<string | null>
	/** Apply one entry to the open store. */
	apply: (entry: JournalEntry) => Promise<unknown>
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
	'ADAPTER_ERROR',
])

/** Whether a failed write is worth trying again at the next start (storage busy, full, locked). */
export function isTransientWriteFailure(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false
	const { code, name, message } = error as { code?: unknown; name?: unknown; message?: unknown }
	if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true
	if (name === 'QuotaExceededError' || name === 'TransactionInactiveError') return true
	return typeof message === 'string' && /\b(locked|busy|quota)\b/i.test(message)
}

/**
 * Apply the entries other, closed sessions left in the journal, oldest first. Kept apart
 * from the queue so the code only a second visit needs stays out of the first paint
 * (first-visit parity, K3).
 *
 * @param context - The journal, locks and the apply function of the running queue
 */
export async function recoverJournal(context: RecoveryContext): Promise<void> {
	const { journal } = context
	const work = async (): Promise<void> => {
		let entries: JournalEntry[]
		try {
			entries = await journal.list()
		} catch (error) {
			context.onUnreadable(error)
			return
		}
		const foreign = entries.filter((entry) => entry.session !== context.session)
		if (foreign.length === 0) return
		const owner = await context.owner()
		const live = await liveSessions(context.locks)
		for (const entry of foreign) {
			if (entry.seq === undefined) continue
			const age = context.now() - entry.at
			if (entry.failed !== undefined) {
				// Kept for inspection, not forever.
				if (age > STALE_AFTER_MS) await journal.remove(entry.seq).catch(() => {})
				continue
			}
			if (live ? live.has(entry.session) : age < ORPHAN_AFTER_MS) continue
			if (entry.owner !== owner) {
				// A write made by another user, or before the app knew who was signed in, is not
				// applied into this user's database: it waits for its owner. An unclaimed one is
				// dropped, loudly.
				if (age > STALE_AFTER_MS) {
					console.warn(
						`[kora] Dropping a write to "${entry.collection}" queued ${Math.round(age / 86_400_000)} days ago by another user and never claimed.`,
					)
					await journal.remove(entry.seq).catch(() => {})
				}
				continue
			}
			try {
				await context.apply(entry)
				await journal.remove(entry.seq)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				const permanent = !isTransientWriteFailure(error)
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
				if (permanent) await journal.markFailed(entry.seq, message).catch(() => {})
			}
		}
	}
	const locks = context.locks
	if (!locks) return work()
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

import type { LockManagerLike } from './pre-ready-writes'
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
		const owner = await context.owner()
		const live = await liveSessions(context.locks)
		for (const entry of entries) {
			if (entry.session === context.session || entry.failed !== undefined) continue
			if (entry.seq === undefined) continue
			const age = context.now() - entry.at
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
				await context.apply(entry)
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
	const locks = context.locks
	if (!locks) return work()
	// One tab recovers at a time, so two tabs opening together never apply an entry twice.
	await locks.request(`kora-journal-drain:${context.dbName}`, { mode: 'exclusive' }, work)
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

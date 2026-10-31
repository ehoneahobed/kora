import type { RecordOperation, WriteTarget } from './pre-ready-writes'
import {
	APPLIED_KEY_TTL_MS,
	type Pending,
	type PreReadyWriteQueue,
	isTimeout,
	withTimeout,
} from './pre-ready-writes'
import type { JournalEntry, WriteJournal } from './write-journal'

/**
 * The journal side of the pre-ready write queue: saving a write to IndexedDB, finding its owner,
 * the session lock, removing applied entries and starting a recovery. None of it is needed to
 * paint, so it loads from its own chunk (the first journaled write, or the runtime opening), and
 * the queue itself keeps only what holds writes in memory and applies them in order.
 */

const SESSION_LOCK_PREFIX = 'kora-journal-session:'
const DEFAULT_OWNER_TIMEOUT_MS = 3000
const DEFAULT_RECOVERY_BUDGET_MS = 5000
const OWNER_RETRIES = 3

/** Opens the journal: the injected one, none without IndexedDB, or the real one. The queue memoizes it. */
export async function openJournal(q: PreReadyWriteQueue): Promise<WriteJournal | null> {
	if (q.journalOverride !== undefined) return q.journalOverride
	// No IndexedDB (a server render, a Node script): the queue is memory only.
	if (typeof indexedDB === 'undefined' || indexedDB === null) return null
	const { openWriteJournal } = await import('./write-journal')
	return openWriteJournal(q.options.dbName)
}

/** Save a write to the journal; null when it cannot or must not be saved. */
export async function saveEntry(q: PreReadyWriteQueue, item: Pending): Promise<number | null> {
	try {
		const journal = await q.bounded(q.getJournal(), 'open the write journal')
		if (!journal) {
			q.noteMemoryOnly(item, 'no-storage')
			return null
		}
		await q.bounded(holdSessionLock(q), 'take the session lock')
		const known = q.knownOwner
		const entry: JournalEntry = {
			session: q.session,
			owner: known?.owner ?? null,
			...(known === null && q.options.resolveOwner ? { ownerPending: true } : {}),
			at: item.writtenAt,
			opKey: item.opKey,
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
		const seq = Number(await q.bounded(journal.append(entry), 'save the write'))
		if (entry.ownerPending) q.track(settleOwner(q, journal, seq))
		return seq
	} catch (error) {
		q.warnOnce(error)
		q.noteMemoryOnly(item, isTimeout(error) ? 'journal-timeout' : 'journal-error')
		return null
	}
}

/**
 * Patch the owner onto an entry that was saved before the signed-in user was known. A lookup
 * that gets no answer (timeout, or the app still `loading`) is retried a few times and then
 * again whenever the app reports a sign-in change (`noteSignedInUser`), so an entry is never
 * left unattributed for want of one slow answer.
 */
async function settleOwner(
	q: PreReadyWriteQueue,
	journal: WriteJournal,
	seq: number,
): Promise<void> {
	q.ownerWaiters.add(seq)
	for (
		let attempt = 0;
		attempt < OWNER_RETRIES && q.ownerWaiters.has(seq) && q.store === null;
		attempt++
	) {
		const answer = await resolveOwner(q)
		if (answer !== null) {
			await patchOwner(q, journal, seq, answer.owner)
			return
		}
	}
}

/** Records the owner of an entry that was saved before it was known. */
export async function patchOwner(
	q: PreReadyWriteQueue,
	journal: WriteJournal,
	seq: number,
	owner: string | null,
): Promise<void> {
	q.ownerWaiters.delete(seq)
	try {
		await q.bounded(journal.update(seq, { owner, ownerPending: false }), 'record the owner')
	} catch (error) {
		q.warnOnce(error)
	}
}

/**
 * The signed-in user, or null while the app cannot tell (a timeout or `loading`: neither is
 * remembered, and neither means "signed out").
 */
export async function resolveOwner(
	q: PreReadyWriteQueue,
): Promise<{ owner: string | null } | null> {
	if (q.knownOwner) return q.knownOwner
	const resolve = q.options.resolveOwner
	if (!resolve) return { owner: null }
	try {
		const value = await withTimeout(
			resolve(),
			q.options.ownerTimeoutMs ?? DEFAULT_OWNER_TIMEOUT_MS,
			'find the signed-in user',
		)
		if (typeof value === 'object' && value !== null) return null
		if (typeof value === 'string' && value !== '') q.knownOwner = { owner: value }
		// Signed out is an answer for this entry, but not for the session: a sign-in may follow.
		return { owner: typeof value === 'string' && value !== '' ? value : null }
	} catch {
		return null
	}
}

/**
 * Remove the journal entry of a write that was applied. A removal that fails or does not
 * answer in time is NOT a failed write: the write is in the store and the store recorded its
 * key in the same transaction, so the leftover entry is recognised at the next start and
 * skipped. Nothing is reported as an error.
 */
export async function forgetApplied(
	q: PreReadyWriteQueue,
	item: Pending,
	store: WriteTarget,
): Promise<void> {
	const seq = await item.appended
	if (seq === null) {
		// Never journaled (atomic helper, secret field, encryption, no IndexedDB): no entry can
		// ever replay it, so its key has nothing to protect.
		await store.forgetJournalApplied?.([item.opKey]).catch(() => {})
		return
	}
	try {
		const journal = await q.bounded(q.getJournal(), 'open the write journal')
		if (!journal) return
		await q.bounded(journal.remove(seq), 'forget the applied write')
	} catch (error) {
		console.warn(
			'[kora] A write queued before the store opened was applied; its journal entry could not be removed yet and is recognised and skipped at the next start:',
			error,
		)
		return
	}
	// The key stays: a stale tab may still replay this entry, and the key makes that a no-op.
	// The 90-day prune removes it.
}

/**
 * Apply the entries other, closed sessions left in the journal. A failure here never blocks
 * the drain: the session's own writes still reach the store and `ready` still resolves, and
 * a pass that runs past its budget stops where it is. Returns the records whose older
 * writes are still waiting. The recovery logic loads only when there is something to recover.
 */
export async function recover(
	q: PreReadyWriteQueue,
	store: WriteTarget,
): Promise<ReadonlySet<string>> {
	try {
		const journal = await q.bounded(q.getJournal(), 'open the write journal')
		if (!journal) return new Set()
		q.scan()
		const entries = (await q.scanned) ?? []
		if (!entries.some((entry) => entry.session !== q.session)) return new Set()
		const { recoverJournal, replayEntry, describeHeld, snapshotHistory } = await import(
			'./pre-ready-recovery'
		)
		const owner = await resolveOwner(q)
		const history = new Map<string, RecordOperation[]>()
		// Every record the pass will touch is read before the first replayed write lands.
		await snapshotHistory(
			store,
			entries.filter((entry) => entry.session !== q.session),
			history,
		).catch(() => {})
		return await recoverJournal({
			journal,
			locks: q.locks,
			dbName: q.options.dbName,
			session: q.session,
			now: q.now,
			owner: owner === null ? undefined : owner.owner,
			forgetApplied: (entry) => store.forgetJournalApplied?.([entry.opKey]),
			pruneApplied: () => store.forgetJournalApplied?.([], APPLIED_KEY_TTL_MS),
			namespacedByUser: q.options.namespacedByUser === true,
			budgetMs: q.options.recoveryBudgetMs ?? DEFAULT_RECOVERY_BUDGET_MS,
			callTimeoutMs: q.journalTimeout,
			apply: (entry) => replayEntry(store, entry, (write) => q.run(store, write, null), history),
			onHeld: (waiting) => q.setHeld(waiting, describeHeld(waiting)),
			onUnreadable: (error) => q.warnRecovery(error),
			emit: (event) => q.options.emit?.(event),
		})
	} catch (error) {
		q.warnRecovery(error)
		return new Set()
	}
}

/** Mark this session alive for as long as the page lives, so other tabs leave its entries alone. */
function holdSessionLock(q: PreReadyWriteQueue): Promise<void> {
	const locks = q.locks
	if (!locks) return Promise.resolve()
	q.sessionLock ??= new Promise<void>((resolve) => {
		locks
			.request(`${SESSION_LOCK_PREFIX}${q.session}`, { mode: 'exclusive' }, () => {
				resolve()
				return new Promise<void>((release) => {
					q.releaseSessionLock = release
				})
			})
			.catch(() => resolve())
	})
	return q.sessionLock
}

import { KoraError } from '@korajs/core/lite'
import type { HeldNodeInfo } from '@korajs/sync'
import { recordKey, targetRecordId, withTimeout } from './pre-ready-writes'
import type {
	JournalDeleteBlockedEvent,
	JournalDiscardedEvent,
	JournalExpiredEvent,
	JournalFailureEvent,
	LockManagerLike,
	RecordOperation,
	ReplayOutcome,
	WriteTarget,
} from './pre-ready-writes'
import type { JournalEntry, WriteJournal } from './write-journal'

/** Prefix of the Web Lock each page session holds while it lives (see `PreReadyWriteQueue`). */
export const SESSION_LOCK_PREFIX = 'kora-journal-session:'
/** A journal entry of another page session is assumed abandoned after this long without Web Locks. */
const ORPHAN_AFTER_MS = 2 * 60 * 1000
/** An entry that failed for good is kept for inspection this long, then removed (announced first). */
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
	/** True when each user has a database of their own (an unattributed write is then held). */
	namespacedByUser: boolean
	/** Longest the pass may run; past it the pass stops and leaves the rest for the next start. */
	budgetMs: number
	/** Longest one journal call may take. */
	callTimeoutMs: number
	/** Apply one entry to the open store, or find that it already happened. */
	apply: (entry: JournalEntry) => Promise<ReplayOutcome>
	/** Forget the store's record of an entry that was removed (best effort). */
	forgetApplied?: (entry: JournalEntry) => Promise<void> | undefined
	/** Forget the store's records old enough that no entry can still need them (best effort). */
	pruneApplied?: () => Promise<void> | undefined
	/** Entries that wait for their owner (not applied, not expired): surfaced as held writes. */
	onHeld?: (entries: JournalEntry[]) => void
	/** The journal could not be listed. */
	onUnreadable: (error: unknown) => void
	/** A recovered write could not be applied, or entries are about to expire. */
	emit: (event: JournalFailureEvent | JournalExpiredEvent) => void
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
	'JOURNAL_TIMEOUT',
])

/**
 * Whether a failed write is worth trying again at the next start (storage busy, full, not
 * durable, a journal that did not answer). Decided by the error's code or name only: a generic
 * storage error (every failed SQL statement raises one) is a bug in the write, and message
 * text is not evidence.
 */
export function isTransientWriteFailure(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false
	const { code, name } = error as { code?: unknown; name?: unknown }
	if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true
	return name === 'QuotaExceededError' || name === 'TransactionInactiveError'
}

/**
 * Whether `entry` can be applied by the user the app has now.
 *
 * - An entry with a known owner belongs to that user alone: it waits for them.
 * - One saved before the user was known, or while nobody was signed in, belongs to nobody in
 *   particular. With ONE database for the device the sync layer holds a write by its node
 *   (`sync.assignHeld` / `discardHeld`), never by whoever signs in next, so applying it is
 *   safe. With a database PER USER there is no way to tell whose database it was meant for, so
 *   it waits (and says so) instead of landing in another user's.
 */
function claim(entry: JournalEntry, context: RecoveryContext): 'mine' | 'wait' | 'unattributed' {
	if (typeof entry.owner === 'string') return entry.owner === context.owner ? 'mine' : 'wait'
	if (!context.namespacedByUser) return 'mine'
	if (entry.ownerPending === true) return 'unattributed'
	// Made while nobody was signed in: it belongs to the signed-out database only.
	return context.owner === null ? 'mine' : 'wait'
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
 * Every journal call is bounded in time: a journal that stops answering ends the pass, it
 * never holds `ready`. The pass stops at the first transient failure (a later entry for the
 * same record must not land before an earlier one that is still waiting) and when it runs
 * past its budget. Returns the records whose writes are still waiting, so this session's
 * writes to them can wait too.
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
		const live = await liveSessions(context.locks, context.callTimeoutMs)
		const started = Date.now()
		let stopped = false
		const expired: JournalEntry[] = []
		const waiting: JournalEntry[] = []
		for (const entry of foreign) {
			if (entry.seq === undefined) continue
			const age = context.now() - entry.at
			if (entry.failed !== undefined) {
				// Kept for inspection, not forever.
				if (age > STALE_AFTER_MS) expired.push(entry)
				continue
			}
			if (live ? live.has(entry.session) : age < ORPHAN_AFTER_MS) continue
			const ownership = claim(entry, context)
			if (ownership !== 'mine') {
				// Not this user's to apply: it stays attributed to its owner, never applied to
				// another user and never expired (unsent writes are not ours to age out): it is
				// reported as a held write until the app assigns or discards it.
				for (const key of entryRecords(entry)) held.add(key)
				waiting.push(entry)
				if (ownership === 'unattributed') {
					context.emit({
						type: 'journal:write-failed',
						dbName: context.dbName,
						collection: entry.collection,
						kind: entry.kind,
						message:
							'The write was saved before the signed-in user was known and waits for its owner.',
						permanent: false,
					})
				}
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
				await context.apply(entry)
			} catch (error) {
				const message = describeFailure(error)
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
				try {
					if (permanent) {
						await call(journal.markFailed(entry.seq, message), 'keep the failed write')
					} else {
						await call(journal.update(entry.seq, { attempts }), 'count the attempt')
					}
				} catch (bookkeeping) {
					// The entry stays as it was; the next start tries it again.
					console.warn('[kora] Could not record the outcome of a recovered write:', bookkeeping)
					stopped = true
				}
				if (!permanent) {
					// Order matters on one record: nothing after this entry is applied this start.
					stopped = true
					for (const key of entryRecords(entry)) held.add(key)
				}
				continue
			}
			// Applied or found already done. Forgetting it is bookkeeping: if the journal does not
			// answer the entry stays, and the store's record of its key makes the next replay a no-op.
			try {
				// The key stays: a tab holding a stale list of the journal may still replay this entry,
				// and the key is what makes that a no-op. The 90-day prune removes it.
				await call(journal.remove(entry.seq), 'forget the applied write')
			} catch (bookkeeping) {
				console.warn(
					'[kora] A recovered write was applied; its journal entry could not be removed yet and is skipped at the next start:',
					bookkeeping,
				)
				stopped = true
			}
		}
		context.onHeld?.(waiting)
		if (expired.length > 0) {
			// Announced before anything is removed, so nobody loses data without the event.
			context.emit({
				type: 'journal:write-expired',
				dbName: context.dbName,
				count: expired.length,
				entries: expired.map((entry) => ({
					collection: entry.collection,
					kind: entry.kind,
					owner: entry.owner,
				})),
			})
			for (const entry of expired) {
				if (entry.seq === undefined) continue
				try {
					await call(journal.remove(entry.seq), 'remove an expired write')
				} catch {
					break
				}
			}
		}
		await context.pruneApplied?.()?.catch(() => {})
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
async function liveSessions(
	locks: LockManagerLike | null,
	timeoutMs: number,
): Promise<Set<string> | null> {
	if (!locks?.query) return null
	try {
		const state = await withTimeout(locks.query(), timeoutMs, 'list the live sessions')
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

function opIdentity(op: RecordOperation): string {
	return op.id ?? `${op.nodeId}|${op.timestamp.wallTime}|${op.timestamp.logical ?? 0}|${op.type}`
}

/** Adds to `known` the operations of other nodes that reached the store since it was read. */
async function addArrivals(
	store: WriteTarget,
	collection: string,
	recordId: string,
	known: RecordOperation[],
): Promise<void> {
	const own = store.getNodeId?.()
	if (own === undefined || !store.getOperationsForRecord) return
	const seen = new Set(known.map(opIdentity))
	for (const op of await store.getOperationsForRecord(collection, recordId)) {
		if (op.nodeId !== own && !seen.has(opIdentity(op))) known.push(op)
	}
}

/**
 * Reads, once and before a pass applies anything, the operations of every record an update or
 * delete in `entries` addresses, so an operation the pass itself writes is never mistaken for
 * an edit made after the user acted.
 *
 * @param store - The open store
 * @param entries - The entries the pass will replay
 * @param history - Filled with each record's operations (shared with `replayEntry`)
 */
export async function snapshotHistory(
	store: WriteTarget,
	entries: readonly JournalEntry[],
	history: Map<string, RecordOperation[]>,
): Promise<void> {
	if (!store.getOperationsForRecord) return
	for (const entry of entries) {
		if (entry.kind !== 'update' && entry.kind !== 'delete') continue
		const target = targetRecordId(entry.kind, entry.args)
		if (target === undefined) continue
		const key = recordKey(entry.collection, target)
		if (!history.has(key)) {
			history.set(key, await store.getOperationsForRecord(entry.collection, target))
		}
	}
}

/**
 * What may be written to the console, the event and the journal about a failed write. A
 * framework error carries its own message (field and collection names, a code), cut to a bounded
 * length; anything else (an error thrown by application code or a driver) could echo the values
 * of the write, so only its type is kept.
 */
export function describeFailure(error: unknown): string {
	if (error instanceof KoraError) {
		const text = `${error.code}: ${error.message}`
		return text.length > 200 ? `${text.slice(0, 200)}...` : text
	}
	return error instanceof Error
		? `${error.name} (details withheld: they may contain the write's values)`
		: 'Unknown error'
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
	opKey: string
}

/**
 * Replay one journal entry onto the open store.
 *
 * Whether the write already happened is answered by the store, not guessed: the store records
 * the entry's `opKey` in the same transaction as the write, so a write that landed is skipped
 * whatever happened afterwards (a crash before the entry was removed, a removal that failed or
 * timed out, an append that landed late).
 *
 * A write that did NOT land is applied with last-write-wins as if it had happened when the user
 * acted: an update leaves out the fields a later operation on the record wrote (any node, this
 * device's other tabs included), and a delete yields to a later write. The replay itself takes a
 * fresh clock timestamp (the clock stays monotonic), so the one thing it cannot see is an edit
 * made on another device that has not reached this one yet; that edit loses to the replay.
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
	history: Map<string, RecordOperation[]> = new Map(),
): Promise<ReplayOutcome> {
	if (await store.hasJournalApplied?.(entry.opKey)) return 'skipped'
	const writtenAt = entry.writtenAt ?? entry.at
	let args = entry.args
	const target =
		entry.kind === 'update' || entry.kind === 'delete'
			? targetRecordId(entry.kind, entry.args)
			: undefined
	// The history of the record an update or delete addresses. The pass reads every such record
	// once, before it applies anything (`snapshotHistory`); a record not in the snapshot is read
	// here. Operations a pass-mate wrote (this device's node) never count as edits "after" the
	// entry, but an edit another node synced since the snapshot is added right before the apply,
	// so it is respected too.
	if (target !== undefined && store.getOperationsForRecord) {
		const key = recordKey(entry.collection, target)
		const known = history.get(key)
		if (known === undefined) {
			history.set(key, await store.getOperationsForRecord(entry.collection, target))
		} else {
			await addArrivals(store, entry.collection, target, known)
		}
	}
	if (target !== undefined && store.getOperationsForRecord) {
		const later = (history.get(recordKey(entry.collection, target)) ?? []).filter(
			(op) => op.timestamp.wallTime > writtenAt,
		)
		if (entry.kind === 'delete') {
			// Last-write-wins: a write after the delete keeps the record alive.
			if (later.some((op) => op.type !== 'delete')) return 'skipped'
		} else {
			if (later.some((op) => op.type === 'delete')) return 'skipped'
			const data = entry.args[1]
			if (typeof data === 'object' && data !== null) {
				const rewritten = new Set(later.flatMap((op) => Object.keys(op.data ?? {})))
				const kept = Object.entries(data).filter(([field]) => !rewritten.has(field))
				if (kept.length === 0) return 'skipped'
				if (kept.length !== Object.keys(data).length)
					args = [entry.args[0], Object.fromEntries(kept)]
			}
		}
	}
	try {
		await run({
			collection: entry.collection,
			kind: entry.kind,
			args,
			...(entry.options ? { options: entry.options } : {}),
			recordId: entry.recordId,
			recordIds: entry.recordIds,
			writtenAt,
			opKey: entry.opKey,
		})
		return 'applied'
	} catch (error) {
		// Another tab applied this very write between the check and the transaction.
		if ((error as { code?: unknown } | null)?.code === 'JOURNAL_ALREADY_APPLIED') return 'skipped'
		// A stale tab replays a write that landed meanwhile: its insert fails as a duplicate, but the
		// store holds the key of this very write, so it is done, not a failure.
		if (await store.hasJournalApplied?.(entry.opKey)) return 'skipped'
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

/** Id of the held node an entry belongs to (see {@link describeHeld}). */
export function heldNodeIdOf(entry: JournalEntry): string {
	if (entry.owner === null && entry.ownerPending === true) return 'journal:unassigned'
	return `journal:other-user:${entry.owner ?? ''}`
}

/**
 * The held writes as the sync layer's held nodes, so `status.heldNodes`, `app.sync.assignHeld`
 * and `app.sync.discardHeld` treat them like writes held by the sync engine. One node per
 * owner; entries saved before the user was known form the assignable `unassigned` node.
 *
 * @param entries - The journal entries waiting for their owner
 * @returns The held nodes, with what each write is
 */
export function describeHeld(entries: JournalEntry[]): HeldNodeInfo[] {
	const nodes = new Map<string, HeldNodeInfo>()
	for (const entry of entries) {
		const nodeId = heldNodeIdOf(entry)
		let node = nodes.get(nodeId)
		if (!node) {
			node = {
				nodeId,
				operationCount: 0,
				reason: nodeId === 'journal:unassigned' ? 'unassigned' : 'other-user',
				principal: nodeId === 'journal:unassigned' ? null : entry.owner,
				source: 'journal',
				writes: [],
				oldestWrittenAt: Number.POSITIVE_INFINITY,
			}
			nodes.set(nodeId, node)
		}
		node.operationCount += 1
		const writtenAt = entry.writtenAt ?? entry.at
		node.oldestWrittenAt = Math.min(node.oldestWrittenAt ?? writtenAt, writtenAt)
		node.writes?.push({
			collection: entry.collection,
			kind: entry.kind,
			writtenAt,
			owner: entry.owner,
		})
	}
	return [...nodes.values()]
}

/** What the held-writes operations use of the queue (see `PreReadyWriteQueue`'s internal members). */
export interface HeldHost {
	heldEntries: JournalEntry[]
	knownOwner: { owner: string | null } | null
	lastUser: string | null | undefined
	ownerWaiters: Set<number>
	patchOwner(journal: WriteJournal, seq: number, owner: string | null): Promise<void>
	store: WriteTarget | null
	journalPromise: Promise<WriteJournal | null> | null
	scanned: Promise<JournalEntry[]> | null
	heldNodes: readonly HeldNodeInfo[]
	session: string
	locks: LockManagerLike | null
	options: {
		dbName: string
		emit?: (event: JournalDiscardedEvent | JournalDeleteBlockedEvent) => void
		/** Waits between attempts to delete a journal another tab keeps open (default 250, 1000 ms). */
		deleteRetryDelaysMs?: readonly number[]
		deleteBlockedTimeoutMs?: number
		namespacedByUser?: boolean
		openedFor?: () => string | null | undefined
	}
	getJournal(): Promise<WriteJournal | null>
	bounded<T>(work: Promise<T>, what: string): Promise<T>
	run(store: WriteTarget, write: ReplayWrite, observer: null): Promise<unknown>
	setHeld(entries: JournalEntry[], nodes: HeldNodeInfo[]): void
	releaseJournal(): Promise<void>
}

async function heldOfNode(host: HeldHost, nodeId: string): Promise<JournalEntry[]> {
	const entries = host.heldEntries.filter((entry) => heldNodeIdOf(entry) === nodeId)
	if (entries.length === 0) {
		const { SyncError } = await import('@korajs/core')
		throw new SyncError(`No held writes belong to "${nodeId}".`, {
			code: 'HELD_NODE_NOT_FOUND',
			nodeId,
			fix: 'Pick a node from status.heldNodes.',
		})
	}
	return entries
}

function release(host: HeldHost, settled: number[]): void {
	if (settled.length > 0) {
		const done = new Set(settled)
		const rest = host.heldEntries.filter((entry) => entry.seq === undefined || !done.has(entry.seq))
		host.setHeld(rest, describeHeld(rest))
	}
	if (host.store) void host.releaseJournal().catch(() => {})
}

/**
 * Apply the held writes of an `unassigned` node into the signed-in user's database, oldest
 * first (`app.sync.assignHeld`). Stops at the first failure: the rest stay held and the error
 * reaches the caller.
 */
export async function assignHeldNode(host: HeldHost, nodeId: string, to?: string): Promise<void> {
	const { SyncError } = await import('@korajs/core')
	const entries = await heldOfNode(host, nodeId)
	if (nodeId !== 'journal:unassigned') {
		throw new SyncError('Only writes held as "unassigned" can be assigned.', {
			code: 'HELD_NODE_NOT_ASSIGNABLE',
			nodeId,
			fix: 'Pick a node from status.heldNodes whose reason is "unassigned".',
		})
	}
	// The same contract as the sync engine's held nodes: the only target is the signed-in user.
	if (to !== undefined && to !== 'current-user') {
		throw new SyncError(`assignHeld only supports 'current-user', got "${String(to)}".`, {
			code: 'HELD_ASSIGN_TARGET',
			nodeId,
		})
	}
	const owner = host.knownOwner?.owner ?? null
	if (owner === null) {
		throw new SyncError('Sign in before assigning held writes to the current user.', {
			code: 'HELD_ASSIGN_NO_USER',
			nodeId,
		})
	}
	const store = host.store
	if (store === null) {
		throw new SyncError('The app is still opening, so held writes cannot be assigned yet.', {
			code: 'HELD_ASSIGN_NOT_READY',
			nodeId,
		})
	}
	// A database per user: the open store belongs to whoever was signed in when it opened (or
	// to nobody). Writing into it would put the writes in the wrong user's database.
	const openedFor = host.options.openedFor?.()
	if (openedFor !== undefined && openedFor !== owner) {
		throw new SyncError(
			'The local database was opened for a different user than the one signed in now, so held writes cannot be assigned until the app reloads.',
			{
				code: 'HELD_ASSIGN_USER_MISMATCH',
				nodeId,
				signedIn: owner,
				openedFor,
				fix: 'Reload the app (or finish signing in) so the database of the signed-in user opens, then assign again.',
			},
		)
	}
	const journal = await host.bounded(host.getJournal(), 'open the write journal')
	const settled: number[] = []
	const history = new Map<string, RecordOperation[]>()
	try {
		if (!journal) return
		const ordered = [...entries].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
		await snapshotHistory(store, ordered, history)
		for (const entry of ordered) {
			if (entry.seq === undefined) continue
			await replayEntry(store, entry, (write) => host.run(store, write, null), history)
			await host.bounded(journal.remove(entry.seq), 'forget the assigned write')
			settled.push(entry.seq)
		}
	} finally {
		release(host, settled)
	}
}

/**
 * Remove the held writes of one node for good (`app.sync.discardHeld`), announcing the count
 * with `journal:discarded`.
 *
 * @returns How many writes were removed
 */
export async function discardHeldNode(host: HeldHost, nodeId: string): Promise<number> {
	const entries = await heldOfNode(host, nodeId)
	const journal = await host.bounded(host.getJournal(), 'open the write journal')
	const settled: number[] = []
	try {
		if (!journal) return 0
		for (const entry of entries) {
			if (entry.seq === undefined) continue
			await host.bounded(journal.remove(entry.seq), 'discard a held write')
			settled.push(entry.seq)
			await host.store?.forgetJournalApplied?.([entry.opKey])?.catch(() => {})
		}
		return settled.length
	} finally {
		release(host, settled)
		if (settled.length > 0) {
			host.options.emit?.({
				type: 'journal:discarded',
				dbName: host.options.dbName,
				count: settled.length,
			})
		}
	}
}

/**
 * A write to a record whose older journaled write could not be applied yet must not land
 * first. When it is saved in the journal it stays there (applied after the older one at the
 * next start) and its caller is told so; one held in memory only goes ahead, since nothing
 * could replay it.
 *
 * @returns True when the write was rejected here (and must not be applied)
 */
export async function blockedByOlderWrite(
	item: {
		collection: string
		kind: JournalEntry['kind']
		args: unknown[]
		appended: Promise<number | null>
		reject: (reason: unknown) => void
	},
	held: ReadonlySet<string>,
): Promise<boolean> {
	const id = targetRecordId(item.kind, item.args)
	if (id === undefined || !held.has(recordKey(item.collection, id))) return false
	const seq = await item.appended
	if (seq === null) return false
	const { KoraError } = await import('@korajs/core')
	item.reject(
		new KoraError(
			`The write to "${item.collection}" was saved on this device but not applied yet: an older write to the same record is waiting for the storage to be ready. It is applied at the next start, after the older one; do not repeat it.`,
			'WRITE_NOT_APPLIED',
			{ collection: item.collection, savedForLater: true },
		),
	)
	return true
}

const DELETE_RETRY_DELAYS_MS: readonly number[] = [250, 1000]

/**
 * Delete the journal of a database: it was wiped or the user signed out, so queued plaintext
 * must not outlive the data it was meant for. Announces the unsent writes thrown away.
 *
 */
export async function discardJournalOf(host: HeldHost): Promise<void> {
	host.scanned = null
	try {
		// Opened here when the drain already released the connection, so the count is never lost.
		const open = await host.bounded(host.getJournal(), 'open the write journal').catch(() => null)
		host.journalPromise = null
		let discarded = 0
		if (open) {
			discarded = await host
				.bounded(open.list(), 'read the write journal')
				.then((entries) => entries.filter((entry) => entry.failed === undefined).length)
				.catch(() => 0)
		}
		open?.close()
		const { deleteWriteJournal } = await import('./write-journal')
		// Another tab may keep the journal open for a moment: retry before giving up, and say so
		// when it stays (the unsent writes are still on the device and still listed as held).
		const delays = host.options.deleteRetryDelaysMs ?? DELETE_RETRY_DELAYS_MS
		let attempts = 0
		for (;;) {
			attempts += 1
			try {
				await deleteWriteJournal(host.options.dbName, host.options.deleteBlockedTimeoutMs)
				break
			} catch (error) {
				const blocked = (error as { code?: unknown } | null)?.code === 'JOURNAL_DELETE_BLOCKED'
				const wait = delays[attempts - 1]
				if (!blocked || wait === undefined) {
					if (blocked) {
						host.options.emit?.({
							type: 'journal:delete-blocked',
							dbName: host.options.dbName,
							attempts,
							message: (error as Error).message,
						})
						return
					}
					throw error
				}
				await new Promise((resolve) => setTimeout(resolve, wait))
			}
		}
		if (host.heldEntries.length > 0) host.setHeld([], [])
		if (discarded > 0) {
			host.options.emit?.({
				type: 'journal:discarded',
				dbName: host.options.dbName,
				count: discarded,
			})
		}
	} catch (error) {
		console.warn('[kora] Could not delete the write journal:', error)
	}
}

/** Remove the failed entries (kept for inspection) of a user who left. */
export async function purgeFailedOf(host: HeldHost, owner: string): Promise<void> {
	try {
		const journal = await host.bounded(host.getJournal(), 'open the write journal')
		if (journal) await purgeFailedEntries(journal, owner, (work, what) => host.bounded(work, what))
	} catch (error) {
		console.warn('[kora] Could not clear the failed writes of the previous user:', error)
	}
}

/**
 * The app reported the signed-in user (`null`: nobody). Entries still waiting for their owner
 * learn it, and when the user changed, the failed writes kept for the previous one are
 * cleared. The first report is the baseline, so a session that starts signed in still notices
 * the sign-out.
 */
export async function noteSignedInUserOf(host: HeldHost, next: string | null): Promise<void> {
	const previous = host.lastUser
	host.lastUser = next
	host.knownOwner = next === null ? null : { owner: next }
	if (host.ownerWaiters.size > 0) {
		const journal = await host
			.bounded(host.getJournal(), 'open the write journal')
			.catch(() => null)
		if (journal) {
			for (const seq of [...host.ownerWaiters]) await host.patchOwner(journal, seq, next)
		}
	}
	if (typeof previous === 'string' && previous !== next) await purgeFailedOf(host, previous)
	// The user changed while the app was open (sign-out, or another account): writes a closed
	// tab left for the previous account now belong to "another account", and the ones for the
	// new user no longer wait for anybody. Listed as held until applied (the next start) or
	// discarded; the first report is only the baseline.
	if (previous !== undefined && previous !== next && host.store !== null)
		await refreshHeld(host, next)
}

/**
 * Recompute which journal entries of other sessions wait, for the user signed in now. Never
 * applies anything: the open store belongs to whoever it was opened for.
 */
async function refreshHeld(host: HeldHost, user: string | null): Promise<void> {
	try {
		const journal = await host.bounded(host.getJournal(), 'open the write journal')
		if (!journal) return
		const entries = await host.bounded(journal.list(), 'read the write journal')
		const live = await liveSessions(host.locks, JOURNAL_REFRESH_TIMEOUT_MS)
		const context = { owner: user, namespacedByUser: host.options.namespacedByUser === true }
		const waiting = entries.filter(
			(entry) =>
				entry.seq !== undefined &&
				entry.failed === undefined &&
				entry.session !== host.session &&
				!(live?.has(entry.session) ?? false) &&
				claim(entry, context as RecoveryContext) !== 'mine',
		)
		host.setHeld(waiting, describeHeld(waiting))
	} catch (error) {
		console.warn('[kora] Could not refresh the writes held for another account:', error)
	}
}

const JOURNAL_REFRESH_TIMEOUT_MS = 3000

/**
 * Reject the writes that waited for a store that never opened, each with an error that says
 * whether it was saved for the next start or lost.
 */
export async function rejectUnapplied(
	items: Array<{ collection: string; reject: (reason: unknown) => void }>,
	saved: Array<number | null>,
	why: string,
	cause: unknown,
): Promise<void> {
	const { KoraError } = await import('@korajs/core')
	const reason = cause instanceof Error ? cause.message : cause === undefined ? null : String(cause)
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
				{ collection: item.collection, savedForLater: kept, cause: reason },
			),
		)
	})
}

/** The console warnings of the pre-ready write queue (kept here, out of the first paint). */
export function warnJournal(
	kind: 'memory-only' | 'save' | 'recovery',
	...details: unknown[]
): void {
	if (kind === 'memory-only') {
		console.warn(
			`[kora] A write to "${String(details[0])}" made before the store opened is held in memory only (${String(details[1])}): it is applied when the store opens, but closing the page first would lose it.`,
		)
	} else if (kind === 'save') {
		console.warn(
			'[kora] Could not save a write made before the store opened to the write journal. It is kept in memory and applied when the store opens, but closing the tab first would lose it:',
			details[0],
		)
	} else {
		console.warn(
			'[kora] Could not recover the writes a closed tab left in the write journal; they stay there and the app opens without them:',
			details[0],
		)
	}
}

/**
 * `deleteDatabase(name)` wiped a database: drop the journal entries meant for it. The base
 * database takes the whole journal; a per-user database (`<base>__user_<id>`) takes only that
 * user's entries (the journal is shared by every user of the device), counted and announced.
 */
export async function discardJournalFor(
	host: HeldHost,
	baseName: string,
	name: string,
): Promise<void> {
	if (name === baseName) return discardJournalOf(host)
	const prefix = `${baseName}__user_`
	if (!name.startsWith(prefix)) return
	const { encodeDbNameComponent } = await import('./db-name')
	const userKey = name.slice(prefix.length)
	try {
		const journal = await host.bounded(host.getJournal(), 'open the write journal')
		if (!journal) return
		let removed = 0
		for (const entry of await host.bounded(journal.list(), 'read the write journal')) {
			if (entry.seq === undefined || entry.ownerPending === true) continue
			const key = entry.owner === null ? 'signed-out' : encodeDbNameComponent(entry.owner)
			if (key !== userKey) continue
			await host.bounded(journal.remove(entry.seq), 'discard a write of the deleted database')
			if (entry.failed === undefined) removed += 1
		}
		host.heldEntries = host.heldEntries.filter(
			(entry) =>
				entry.ownerPending === true ||
				(entry.owner === null ? 'signed-out' : encodeDbNameComponent(entry.owner)) !== userKey,
		)
		host.setHeld(host.heldEntries, describeHeld(host.heldEntries))
		if (removed > 0) {
			host.options.emit?.({
				type: 'journal:discarded',
				dbName: host.options.dbName,
				count: removed,
			})
		}
	} catch (error) {
		console.warn(
			'[kora] Could not delete the write journal entries of the deleted database:',
			error,
		)
	}
}

/**
 * `sync.unassignedWrites: 'assign-to-first-user'` for writes still in the journal: when the sync
 * server accepts a session, the journal's unassigned writes are assigned to the signed-in user,
 * like the sync engine's own unassigned nodes.
 *
 * @returns Unsubscribe function
 */
export function assignJournalOnConnect(
	emitter: { on(type: 'sync:connected', handler: () => void): () => void },
	queue: HeldHost & { assignHeld(nodeId: string): Promise<void> },
): () => void {
	let running = false
	return emitter.on('sync:connected', () => {
		if (running || !queue.heldNodes.some((node) => node.nodeId === 'journal:unassigned')) return
		running = true
		queue
			.assignHeld('journal:unassigned')
			.catch((error: unknown) => {
				console.warn(
					'[kora] Could not assign the unassigned journal writes to the signed-in user:',
					error,
				)
			})
			.finally(() => {
				running = false
			})
	})
}

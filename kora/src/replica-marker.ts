/**
 * Whether this device has a completed replica, readable before the store opens.
 *
 * A device whose replica completed answers its queries from the store and catches up through
 * the stream (`docs/design/first-visit-parity.md` 5.3): it must not read through. Seeding skips
 * a record that already has local history, so a server answer shown first would be replaced by
 * the older local row until delivery caught up, and the page would go fresh, stale, fresh. A
 * device whose first download never finished is not returning: its live database can still be
 * empty, and it keeps the fast first screen.
 *
 * The completion mark that proves this lives inside the database, which is not open yet, so its
 * existence is recorded in `localStorage`, tied to the database's epoch
 * (`kora:db:<name>`, `@korajs/store` storage evidence). A database that was deleted or evicted
 * gets a new epoch or none, which invalidates the record without anything having to clear it.
 */

const COMPLETE_PREFIX = 'kora:replica-complete:'
const DATABASE_MARKER_PREFIX = 'kora:db:'

function storage(): Storage | null {
	try {
		return (globalThis as { localStorage?: Storage }).localStorage ?? null
	} catch {
		// Access can throw (blocked site data, sandboxed frames): nothing is known.
		return null
	}
}

function databaseEpoch(dbName: string): string | null {
	try {
		const raw = storage()?.getItem(`${DATABASE_MARKER_PREFIX}${dbName}`)
		if (!raw) return null
		const epoch = (JSON.parse(raw) as { epoch?: unknown } | null)?.epoch
		return typeof epoch === 'string' ? epoch : null
	} catch {
		return null
	}
}

/** Whether `dbName`'s current database has completed a replica on this device. */
export function hasCompletedReplica(dbName: string): boolean {
	const epoch = databaseEpoch(dbName)
	if (epoch === null) return false
	try {
		return storage()?.getItem(`${COMPLETE_PREFIX}${dbName}`) === epoch
	} catch {
		return false
	}
}

function recordCompletedReplica(dbName: string): void {
	const epoch = databaseEpoch(dbName)
	if (epoch === null) return
	try {
		storage()?.setItem(`${COMPLETE_PREFIX}${dbName}`, epoch)
	} catch {
		// Quota or blocked storage: the next visit reads through, as a first visit does.
	}
}

/** What {@link watchCompletedReplica} reads. */
export interface CompletedReplicaWatch {
	dbName: string
	/** The database's completion marks. */
	loadMarks: () => Promise<{ marks: readonly unknown[] }>
	/** Subscribes to sync status; absent when the app does not sync. */
	subscribeStatus?: (listener: (status: { activeViewComplete?: boolean }) => void) => () => void
}

/**
 * Records the replica as completed once the open database holds a completion mark: at once for
 * a device that completed earlier, otherwise when the active view is first complete.
 *
 * @returns A function that stops watching
 */
export function watchCompletedReplica(options: CompletedReplicaWatch): () => void {
	let done = false
	let checking = false
	let unsubscribe: (() => void) | undefined
	const stop = (): void => {
		done = true
		unsubscribe?.()
		unsubscribe = undefined
	}
	const check = (): void => {
		if (done || checking) return
		checking = true
		// Through a promise: the store throws synchronously once the app has closed.
		Promise.resolve()
			.then(options.loadMarks)
			.then(
				({ marks }) => {
					checking = false
					if (done || marks.length === 0) return
					recordCompletedReplica(options.dbName)
					stop()
				},
				() => {
					// Advisory: a failed read leaves this device reading through, as a first visit does.
					checking = false
				},
			)
	}
	unsubscribe = options.subscribeStatus?.((status) => {
		if (status.activeViewComplete === true) check()
	})
	check()
	return stop
}

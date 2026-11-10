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

export const COMPLETE_PREFIX = 'kora:replica-complete:'
const DATABASE_MARKER_PREFIX = 'kora:db:'

export function storage(): Storage | null {
	try {
		return (globalThis as { localStorage?: Storage }).localStorage ?? null
	} catch {
		// Access can throw (blocked site data, sandboxed frames): nothing is known.
		return null
	}
}

export function databaseEpoch(dbName: string): string | null {
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

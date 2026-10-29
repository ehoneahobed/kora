/// <reference lib="dom" />
/**
 * Evidence that a database existed on this device, kept OUTSIDE the database (A1 of the
 * offline-readiness design, section 6).
 *
 * A database whose OPFS pool or IndexedDB copy vanished reopens empty, and an empty
 * database looks exactly like a first visit. Two independent records tell the two apart:
 *
 * 1. the storage manifest (IndexedDB `kora-manifest`), extended with the database's
 *    `epoch` and its last known unsynced-write count;
 * 2. `localStorage['kora:db:<name>']`, which survives the loss of the IndexedDB copy the
 *    manifest shares a backend with, and carries the backend itself.
 *
 * Both are written only after a database finished its first durable open, so a crash
 * during creation never leaves evidence of a database that never existed.
 */

import {
	type LocalDatabaseBackend,
	type LocalDatabaseRecord,
	isManifestAvailable,
	patchManifestRecord,
	readManifestRecord,
} from './storage-manifest'

const MARKER_PREFIX = 'kora:db:'
const MARKER_VERSION = 1

/** The `localStorage` marker of a database. */
export interface StorageMarker {
	v: 1
	epoch: string
	backend: LocalDatabaseBackend
}

/** What survived outside the database at the time it was opened. */
export interface FoundStorageEvidence {
	manifest: LocalDatabaseRecord | null
	marker: StorageMarker | null
}

/**
 * A database that existed and vanished (`store:storage-evicted`, `storage.evicted`).
 */
export interface StorageEviction {
	dbName: string
	/** Wall-clock milliseconds the loss was detected. */
	detectedAt: number
	/** Wall-clock milliseconds of the vanished database's last durable open, when known. */
	lastOpenedAt: number | null
	/** Which independent records named the vanished database. */
	evidence: Array<'manifest' | 'localStorage'>
	/**
	 * Unsynced writes the vanished database held when it was last recorded. `certain` is
	 * true when no write followed that recording; otherwise the count may be too low.
	 */
	lostWrites: { count: number; certain: boolean }
}

/** The `localStorage` key of a database's marker. */
export function storageMarkerKey(dbName: string): string {
	return `${MARKER_PREFIX}${dbName}`
}

function markerStorage(): Storage | null {
	try {
		const storage = (globalThis as { localStorage?: Storage }).localStorage
		return storage ?? null
	} catch {
		// Access can throw (blocked site data, sandboxed frames): no marker is kept.
		return null
	}
}

/**
 * Read a database's marker. A marker without a backend (malformed, or written by a future
 * format this build does not read) is ignored, never reported.
 */
export function readStorageMarker(dbName: string): StorageMarker | null {
	try {
		const raw = markerStorage()?.getItem(storageMarkerKey(dbName))
		if (!raw) return null
		const parsed = JSON.parse(raw) as Partial<StorageMarker> | null
		if (
			parsed === null ||
			typeof parsed !== 'object' ||
			parsed.v !== MARKER_VERSION ||
			typeof parsed.epoch !== 'string' ||
			(parsed.backend !== 'opfs' && parsed.backend !== 'indexeddb')
		) {
			return null
		}
		return { v: MARKER_VERSION, epoch: parsed.epoch, backend: parsed.backend }
	} catch {
		return null
	}
}

/** Write a database's marker; failures are ignored (the manifest remains). */
export function writeStorageMarker(dbName: string, marker: StorageMarker): void {
	try {
		markerStorage()?.setItem(storageMarkerKey(dbName), JSON.stringify(marker))
	} catch {
		// Quota or blocked storage: the manifest is still evidence.
	}
}

/** Remove a database's marker (an explicit deletion is not an eviction). */
export function clearStorageMarker(dbName: string): void {
	try {
		markerStorage()?.removeItem(storageMarkerKey(dbName))
	} catch {
		// Nothing to clear.
	}
}

/** Read what survived outside the database, before any open refreshes it. */
export async function readFoundStorageEvidence(dbName: string): Promise<FoundStorageEvidence> {
	let manifest: LocalDatabaseRecord | null = null
	if (isManifestAvailable()) {
		try {
			manifest = await readManifestRecord(dbName)
		} catch {
			// An unreadable manifest is no evidence; the marker may still be.
		}
	}
	return { manifest, marker: readStorageMarker(dbName) }
}

/**
 * Evidence kept for one open database: what was found at open, and the writers that keep
 * the records current. Adapters that persist durably create one per open.
 */
export class StorageEvidence {
	readonly dbName: string
	readonly backend: LocalDatabaseBackend
	private readonly found: FoundStorageEvidence

	constructor(options: {
		dbName: string
		backend: LocalDatabaseBackend
		found: FoundStorageEvidence
	}) {
		this.dbName = options.dbName
		this.backend = options.backend
		this.found = options.found
	}

	/**
	 * The eviction these records prove, or null. Only meaningful for a database that was
	 * just created (the caller checks); a record for ANOTHER backend is never evidence (the
	 * explicit IndexedDB/OPFS migration or `StorageBackendMismatchError` governs that case,
	 * and this holds with the `localStorage` marker alone).
	 */
	detectEviction(now: number = Date.now()): StorageEviction | null {
		const evidence: Array<'manifest' | 'localStorage'> = []
		const manifest = this.found.manifest
		// DECISION: a manifest record counts when it has an epoch (the first durable open
		// finished), or - for records written before epochs existed - when the database was
		// opened at least twice. A record without an epoch from a single open could belong to a
		// database whose creation crashed before it held anything, and reporting that as a loss
		// would be a false positive.
		if (
			manifest !== null &&
			manifest.backend === this.backend &&
			(manifest.epoch !== undefined || manifest.lastOpenedAt > manifest.createdAt)
		) {
			evidence.push('manifest')
		}
		if (this.found.marker !== null && this.found.marker.backend === this.backend) {
			evidence.push('localStorage')
		}
		if (evidence.length === 0) return null
		const count = evidence.includes('manifest') ? (manifest?.unsynced ?? 0) : 0
		return {
			dbName: this.dbName,
			detectedAt: now,
			lastOpenedAt: evidence.includes('manifest') ? (manifest?.lastOpenedAt ?? null) : null,
			evidence,
			lostWrites: {
				count,
				// Exact only when a manifest recorded it as such; a marker alone knows nothing.
				certain: evidence.includes('manifest') && manifest?.unsyncedExact === true,
			},
		}
	}

	/**
	 * Record the database's epoch after its first durable open completed. `fresh` marks a
	 * database that was just created (including after an eviction): its unsynced count
	 * restarts at zero, exactly.
	 */
	async recordEpoch(epoch: string, fresh: boolean): Promise<void> {
		const { manifest, marker } = this.found
		if (marker?.epoch !== epoch || marker.backend !== this.backend) {
			writeStorageMarker(this.dbName, { v: MARKER_VERSION, epoch, backend: this.backend })
		}
		if (!isManifestAvailable()) return
		if (!fresh && manifest?.epoch === epoch && manifest.backend === this.backend) return
		await patchManifestRecord(this.dbName, this.backend, {
			epoch,
			...(fresh ? { unsynced: 0, unsyncedAt: Date.now(), unsyncedExact: true } : {}),
		})
	}

	/**
	 * Record how many writes only this device holds. Written when the count crosses zero
	 * and when the page is hidden, so it is cheap and at worst stale (`exact` false).
	 */
	async recordUnsynced(count: number, exact: boolean): Promise<void> {
		if (!isManifestAvailable()) return
		await patchManifestRecord(this.dbName, this.backend, {
			unsynced: count,
			unsyncedAt: Date.now(),
			unsyncedExact: exact,
		})
	}
}

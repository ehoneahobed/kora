import type { MaterializedRecord, ServerStore } from '../store/server-store'

/** How long a record read for a presence decision is reused when nothing wrote to it. */
const CACHE_TTL_MS = 1000
/** Records whose last read (and last write) the reader remembers. */
const MAX_TRACKED_RECORDS = 10_000
/** Store reads for presence decisions running at once, across every session. */
const MAX_CONCURRENT_READS = 16

/** One read of a record for a presence decision. */
export interface PresenceRecordRead {
	/** The stored row (soft-deleted rows included), or null when the server holds none */
	stored: MaterializedRecord | null
	/**
	 * The reader's clock when the read began. A write that touched the record after
	 * it ({@link PresenceRecords.touchedSince}) means the row may predate that write.
	 */
	asOf: number
}

interface InFlightRead {
	startedAt: number
	promise: Promise<MaterializedRecord | null>
}

interface CachedRead {
	stored: MaterializedRecord | null
	startedAt: number
	atMs: number
}

/**
 * Reads the records presence cursors name, for every session of one sync server (F16).
 *
 * Presence decides who may see a cursor from the record it names, so the row must be
 * the store's latest, never a copy another code path holds (a session's delivery
 * pass caches rows for the whole chunk it filters). Every write the server commits
 * {@link touch}es the records it wrote; a read is current when no touch of its record
 * came after it began. Reads of one record are shared while current (many cursors on
 * one busy document cost one read per write burst, not one per cursor per write), a
 * read is never shared across a touch, and reads are bounded in number at once.
 *
 * Presence is ephemeral and nothing here is persisted.
 */
export class PresenceRecords {
	private clock = 0
	/** The clock value of each tracked record's last touch, oldest first. */
	private readonly lastTouch = new Map<string, number>()
	/** Touches forgotten to bound memory count as having happened at this clock. */
	private forgottenTouchesAt = 0
	private readonly inFlight = new Map<string, InFlightRead>()
	private readonly cache = new Map<string, CachedRead>()
	private running = 0
	private readonly waiting: Array<() => void> = []

	constructor(
		private readonly store: ServerStore,
		private readonly now: () => number = Date.now,
	) {}

	/**
	 * Record that writes to these records committed: reads that began before are no
	 * longer current. Null means any record may have changed.
	 *
	 * @param keys - Record keys from {@link presenceRecordKey}, or null for every record
	 */
	touch(keys: Iterable<string> | null): void {
		this.clock += 1
		if (keys === null) {
			this.forgottenTouchesAt = this.clock
			this.lastTouch.clear()
			this.cache.clear()
			return
		}
		for (const key of keys) {
			this.lastTouch.delete(key)
			this.lastTouch.set(key, this.clock)
			this.cache.delete(key)
		}
		this.forget(this.lastTouch, (value) => {
			this.forgottenTouchesAt = Math.max(this.forgottenTouchesAt, value)
		})
	}

	/**
	 * True when a write touched the record after a read that began at `asOf`.
	 *
	 * @param key - Record key from {@link presenceRecordKey}
	 * @param asOf - The read's {@link PresenceRecordRead.asOf}
	 */
	touchedSince(key: string, asOf: number): boolean {
		return (this.lastTouch.get(key) ?? this.forgottenTouchesAt) > asOf
	}

	/**
	 * A current read of the record that is still fresh enough to reuse, without a store
	 * read; undefined when the record must be read.
	 *
	 * @param collection - The record's collection
	 * @param recordId - The record's id
	 */
	peek(collection: string, recordId: string): PresenceRecordRead | undefined {
		const key = presenceRecordKey(collection, recordId)
		const cached = this.cache.get(key)
		if (!cached) return undefined
		if (this.now() - cached.atMs >= CACHE_TTL_MS || this.touchedSince(key, cached.startedAt)) {
			this.cache.delete(key)
			return undefined
		}
		return { stored: cached.stored, asOf: cached.startedAt }
	}

	/**
	 * Read the record from the store, joining a read of it already running when no
	 * write touched the record since that read began. Rejects when the store read fails.
	 *
	 * @param collection - The record's collection
	 * @param recordId - The record's id
	 */
	async read(collection: string, recordId: string): Promise<PresenceRecordRead> {
		const key = presenceRecordKey(collection, recordId)
		let entry = this.inFlight.get(key)
		if (!entry || this.touchedSince(key, entry.startedAt)) {
			const startedAt = this.clock
			const created: InFlightRead = {
				startedAt,
				promise: this.readStore(collection, recordId),
			}
			entry = created
			this.inFlight.set(key, created)
			void created.promise.then(
				(stored) => {
					if (this.inFlight.get(key) === created) this.inFlight.delete(key)
					if (this.touchedSince(key, startedAt)) return
					this.cache.delete(key)
					this.cache.set(key, { stored, startedAt, atMs: this.now() })
					this.forget(this.cache, () => {})
				},
				() => {
					if (this.inFlight.get(key) === created) this.inFlight.delete(key)
				},
			)
		}
		const stored = await entry.promise
		return { stored, asOf: entry.startedAt }
	}

	/** Forget every read and touch (the server stopped). */
	clear(): void {
		this.touch(null)
		this.inFlight.clear()
	}

	private async readStore(
		collection: string,
		recordId: string,
	): Promise<MaterializedRecord | null> {
		if (this.running < MAX_CONCURRENT_READS) {
			this.running += 1
		} else {
			// A finishing read hands its slot over, so the count never passes the bound.
			await new Promise<void>((resolve) => this.waiting.push(resolve))
		}
		try {
			const rows = await this.store.queryCollection(collection, {
				where: { id: recordId },
				includeDeleted: true,
				limit: 1,
			})
			return rows[0] ?? null
		} finally {
			const next = this.waiting.shift()
			if (next) next()
			else this.running -= 1
		}
	}

	private forget<V>(map: Map<string, V>, onForget: (value: V) => void): void {
		while (map.size > MAX_TRACKED_RECORDS) {
			const oldest = map.keys().next()
			if (oldest.done) return
			const value = map.get(oldest.value)
			map.delete(oldest.value)
			if (value !== undefined) onForget(value)
		}
	}
}

/** The key presence uses for one record. */
export function presenceRecordKey(collection: string, recordId: string): string {
	return `${collection}\u0000${recordId}`
}

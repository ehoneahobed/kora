import type { KoraEventEmitter } from '@korajs/core'

/** The part of the sync engine the tracker reads. */
export interface UnsyncedCountSource {
	/** The engine's outbound count (queued, in flight and unacknowledged writes). */
	getStatus(): { pendingOperations: number }
	onStatusChange(listener: () => void): () => void
}

/** Options for {@link wireUnsyncedTracking}. */
export interface UnsyncedTrackingOptions {
	emitter: KoraEventEmitter
	/** The sync engine, or null for a local-only app (every write stays on this device). */
	engine: UnsyncedCountSource | null
	/** The count at open: what the database already holds that no server acknowledged. */
	initialCount: number
	/** Write the count next to the database (the storage manifest). Failures are ignored. */
	record: (count: number, exact: boolean) => Promise<void>
}

/**
 * Keep the number of writes only this device holds next to the database, so a database
 * that vanishes can say what it lost (`store:storage-evicted`, `lostWrites`).
 *
 * Written when the count crosses zero (either way) and when the page is hidden, so it is
 * cheap and at worst stale. `exact` says no write followed the recording:
 * - a count of zero recorded at a crossing is exact until the next write (which crosses
 *   zero again and records `exact: false`);
 * - a positive count is exact only for a local-only app, where this module counts every
 *   write itself; with sync the engine's count may lag the queue, so it is stale.
 *
 * @returns A cleanup function that removes the listeners
 */
export function wireUnsyncedTracking(options: UnsyncedTrackingOptions): () => void {
	const { emitter, engine, record } = options
	let localCount = options.initialCount
	let lastRecorded: { count: number; exact: boolean } | null = null

	const current = (): number => {
		if (!engine) return localCount
		// The engine's queue is loaded when it starts; until then writes of this session are
		// still counted locally and the database's earlier ones by the initial count.
		return Math.max(engine.getStatus().pendingOperations, localCount)
	}

	const write = (count: number, exact: boolean): void => {
		if (lastRecorded?.count === count && lastRecorded.exact === exact) return
		lastRecorded = { count, exact }
		record(count, exact).catch((error: unknown) => {
			console.warn('[kora] Could not record the unsynced write count:', error)
		})
	}

	// A crossing of zero in either direction, or the first sight of a positive count.
	const onChange = (): void => {
		const count = current()
		const wasPositive = lastRecorded !== null && lastRecorded.count > 0
		if (count > 0 && !wasPositive) write(count, false)
		else if (count === 0 && (lastRecorded === null || lastRecorded.count > 0)) write(0, true)
	}

	const onHidden = (): void => {
		const count = current()
		write(count, count === 0 || engine === null)
	}

	const offCreated = emitter.on('operation:created', () => {
		if (!engine) localCount++
		else localCount = Math.max(localCount, 1)
		// A write after an exact recording makes it stale.
		if (lastRecorded?.exact === true && current() > 0) write(current(), false)
		else onChange()
	})
	const offEngine = engine?.onStatusChange(() => {
		// The engine's queue drained (or the local floor was cleared by its acknowledgment).
		if (engine.getStatus().pendingOperations === 0) localCount = 0
		onChange()
	})

	const onVisibility = (): void => {
		if (typeof document !== 'undefined' && document.visibilityState === 'hidden') onHidden()
	}
	if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
	if (typeof window !== 'undefined') window.addEventListener('pagehide', onHidden)

	// The database's state at open, if it differs from what the previous session recorded.
	onChange()

	return () => {
		offCreated()
		offEngine?.()
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', onVisibility)
		}
		if (typeof window !== 'undefined') window.removeEventListener('pagehide', onHidden)
	}
}

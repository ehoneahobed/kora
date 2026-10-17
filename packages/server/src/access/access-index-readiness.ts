import { randomUUID } from 'node:crypto'

/**
 * Whether a server store's membership index may be used to judge access rules, as one
 * store instance knows it. Shared by the built-in stores so they follow one rule:
 *
 * - Every operation that changes materialized records or the index outside a single
 *   write transaction (installing a schema, changing transforms, a replace-mode restore)
 *   runs under {@link hold}. While any hold is open the index is not ready.
 * - A hold that fails after it changed state (`mutated()`) leaves the index stuck: it no
 *   longer matches the records, and access rules stay out of force until a rebuild
 *   succeeds ({@link rebuilt}).
 * - Another instance's rebuild is seen through the shared rebuilding marker, read by
 *   every index read ({@link seen}).
 *
 * Holds of one instance run one at a time (each with its own marker), and are counted,
 * so one operation finishing never releases another's.
 */
export class AccessIndexReadiness {
	private holds = 0
	private stuck = false
	private rebuildingSeen = false
	private generationSeen: string | null = null
	private rebuilds = 0
	/**
	 * The shared rebuilding markers (keys) this instance wrote or adopted, removed by its
	 * next successful rebuild that no other hold of this instance outlives.
	 */
	private markers = new Set<string>()
	/** The marker of the hold running now (each hold writes its own). */
	private holdMarker: string | null = null
	/** Holds of one instance run one at a time: each owns its marker and its rebuild. */
	private tail: Promise<unknown> = Promise.resolve()
	private renewTimer: ReturnType<typeof setInterval> | null = null
	private recovering = false

	/** True when sessions may judge access rules against the index. */
	isReady(): boolean {
		return this.holds === 0 && !this.stuck && !this.rebuildingSeen
	}

	/** The index generation this instance last saw. */
	generation(): string | null {
		return this.generationSeen
	}

	/** Bumped by every rebuild of this instance: an index read records it when it starts. */
	rebuildCount(): number {
		return this.rebuilds
	}

	/**
	 * The running hold's marker key (one per hold, kept until a rebuild removes it):
	 * `<prefix><owner>:<random>`, so an instance restarting under the same identity can
	 * tell its own abandoned markers from another instance's live ones.
	 */
	ownMarker(prefix: string, owner: string): string {
		if (this.holdMarker === null) {
			this.holdMarker = `${prefix}${owner}:${randomUUID()}`
			this.markers.add(this.holdMarker)
		}
		return this.holdMarker
	}

	/**
	 * Keeps the running hold's marker lease alive (every `everyMs`) until the hold ends,
	 * so other instances never take it for abandoned while this rebuild runs.
	 */
	keepMarkerAlive(renew: (key: string) => Promise<void>, everyMs: number): void {
		const key = this.holdMarker
		if (key === null || this.renewTimer !== null) return
		this.renewTimer = setInterval(() => {
			renew(key).catch(() => {
				// A failed renewal only shortens the lease; the rebuild goes on.
			})
		}, everyMs)
		this.renewTimer.unref?.()
	}

	/**
	 * Starts `rebuild` (a full rebuild that adopts abandoned markers) when an index read
	 * found only markers whose lease ran out: their process stopped before its rebuild
	 * committed, so the index may not match the records until someone rebuilds it. Not
	 * while this instance holds the index (its own rebuild will adopt them), nor twice at
	 * once. A failure leaves the markers in place: the next read starts it again.
	 */
	recoverAbandoned(rebuild: () => Promise<void>): void {
		if (this.holds > 0 || this.recovering) return
		this.recovering = true
		rebuild()
			.catch(() => {
				// Access rules stay out of force (the markers remain); the next read retries.
			})
			.finally(() => {
				this.recovering = false
			})
	}

	/** Takes over markers left by an interrupted rebuild (this instance's rebuild finishes it). */
	adopt(keys: readonly string[]): void {
		for (const key of keys) this.markers.add(key)
	}

	/**
	 * The marker keys a rebuild committing now removes: the running hold's, and those of
	 * earlier holds of this instance that failed part-way or were adopted (holds never
	 * overlap, so none of them belongs to a rebuild still running here).
	 */
	removableMarkers(): string[] {
		return [...this.markers]
	}

	/**
	 * Run an operation that may change records or the index. `mutated()` marks the point
	 * from which a failure leaves them out of step.
	 */
	async hold<T>(run: (mutated: () => void) => Promise<T>): Promise<T> {
		// Counted from the call, so the index is not ready while a rebuild waits its turn.
		this.holds += 1
		const turn = this.tail.then(() => this.runHold(run))
		this.tail = turn.then(
			() => undefined,
			() => undefined,
		)
		return turn
	}

	private async runHold<T>(run: (mutated: () => void) => Promise<T>): Promise<T> {
		this.holdMarker = null
		let changed = false
		try {
			return await run(() => {
				changed = true
			})
		} catch (error) {
			if (changed) this.stuck = true
			throw error
		} finally {
			this.holds -= 1
			this.holdMarker = null
			if (this.renewTimer !== null) {
				clearInterval(this.renewTimer)
				this.renewTimer = null
			}
		}
	}

	/** {@link hold} for a synchronous operation. */
	holdSync<T>(run: (mutated: () => void) => T): T {
		// Synchronous: nothing else of this instance runs meanwhile.
		this.holdMarker = null
		this.holds += 1
		let changed = false
		try {
			return run(() => {
				changed = true
			})
		} catch (error) {
			if (changed) this.stuck = true
			throw error
		} finally {
			this.holds -= 1
		}
	}

	/** A rebuild committed: the index matches the records again (this instance's view). */
	rebuilt(generation: string | null, markerRemains: boolean, removed: readonly string[]): void {
		this.rebuilds += 1
		this.generationSeen = generation
		this.rebuildingSeen = markerRemains
		this.stuck = false
		for (const key of removed) this.markers.delete(key)
	}

	/** True after a rebuild failed part-way: the next rebuild must run in full. */
	isStuck(): boolean {
		return this.stuck
	}

	/**
	 * What an index read saw, unless this instance rebuilt after the read started (the
	 * read may predate the rebuild and would rewind the view).
	 */
	seen(generation: string | null, rebuilding: boolean, rebuildsAtRead: number): void {
		if (rebuildsAtRead !== this.rebuilds) return
		this.generationSeen = generation
		this.rebuildingSeen = rebuilding
	}
}

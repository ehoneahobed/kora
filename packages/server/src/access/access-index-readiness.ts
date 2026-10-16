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
 * Holds are counted, so one operation finishing never releases another's.
 */
export class AccessIndexReadiness {
	private holds = 0
	private stuck = false
	private rebuildingSeen = false
	private generationSeen: string | null = null
	private rebuilds = 0
	/**
	 * The shared rebuilding marker this instance wrote or adopted (its value), removed by
	 * this instance's next successful rebuild. Null when it owns none.
	 */
	markerToken: string | null = null

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

	/** A fresh marker value for a rebuild this instance starts (kept until it rebuilds). */
	ownMarker(): string {
		if (this.markerToken === null) this.markerToken = randomUUID()
		return this.markerToken
	}

	/**
	 * Run an operation that may change records or the index. `mutated()` marks the point
	 * from which a failure leaves them out of step.
	 */
	async hold<T>(run: (mutated: () => void) => Promise<T>): Promise<T> {
		this.holds += 1
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
		}
	}

	/** {@link hold} for a synchronous operation. */
	holdSync<T>(run: (mutated: () => void) => T): T {
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
	rebuilt(generation: string | null, markerRemains: boolean): void {
		this.rebuilds += 1
		this.generationSeen = generation
		this.rebuildingSeen = markerRemains
		this.stuck = false
		this.markerToken = null
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

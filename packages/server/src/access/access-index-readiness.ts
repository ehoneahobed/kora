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
	 * The shared rebuilding markers (keys) this instance wrote or adopted, removed by its
	 * next successful rebuild that no other hold of this instance outlives.
	 */
	private markers = new Set<string>()

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

	/** This instance's marker key (created once, kept until a rebuild removes it). */
	ownMarker(prefix: string): string {
		for (const key of this.markers) if (key.startsWith(`${prefix}own:`)) return key
		const key = `${prefix}own:${randomUUID()}`
		this.markers.add(key)
		return key
	}

	/** Takes over markers left by an interrupted rebuild (this instance's rebuild finishes it). */
	adopt(keys: readonly string[]): void {
		for (const key of keys) this.markers.add(key)
	}

	/**
	 * The marker keys a rebuild committing now may remove: none while another hold of
	 * this instance is still running (its marker must stay until it rebuilds too).
	 */
	removableMarkers(): string[] {
		return this.holds <= 1 ? [...this.markers] : []
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

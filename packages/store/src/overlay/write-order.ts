/*
 * Keeps the start order of local updates, deletes and transactions that touch the SAME
 * record equal to their call order when one of them has to read before it can be predicted
 * (instant-UI stage S6b).
 *
 * A write registers its prediction and starts its storage transaction in ONE synchronous
 * step, so that overlapping writes register in transaction order (design 5.6) and the
 * operation log is the one written with the overlay off (I2). When a prediction first needs
 * a read (the record's row, or the fold state an array write builds on), that step is split
 * by an `await`: a write called later would start first, and `update(id); delete(id)`
 * issued without awaiting would run as delete, update and fail. A write that reads holds
 * the turn of its record; a write called while that turn is held waits for it. Writes of
 * other records never wait, so 500 updates of cold records read in parallel, and a write
 * that needs no read and touches no held record takes no turn (a map lookup). A delete also
 * waits for every held turn, because its cascades write other records, and while it is held
 * it is a barrier: every write called after it waits for it, whatever record it touches. Consequence, by
 * design: operations of independent records may be logged in a different order than with the
 * overlay off when one of them had to read (per-record order is always the call order).
 */

/** One write's place in the order of the writes that read. */
export interface WriteTurn {
	/**
	 * Resolves when every earlier write that was still reading has started its storage
	 * transaction. Null when there is none: the write proceeds synchronously. Await it
	 * before reading.
	 */
	readonly wait: Promise<void> | null
	/**
	 * The write is going to be asynchronous (it reads): writes called from now on wait for
	 * it. Already held when `wait` is not null.
	 */
	hold(): void
	/** The write has started its storage transaction, or was given up. Idempotent. */
	release(): void
}

/** Per-registry bookkeeping of the writes that are reading, by record key. */
export class WriteOrder {
	private readonly tails = new Map<string, Promise<void>>()
	/** The turn of a write that waits for everything (a delete): every later write waits for it. */
	private barrier: Promise<void> | null = null

	/**
	 * Call synchronously when a local update, delete or transaction is called.
	 *
	 * @param keys - The records the write touches (`recordKey(collection, id)`)
	 * @param options - `all`: also wait for every held turn (a delete, whose cascades reach
	 *   other records)
	 */
	enter(keys: readonly string[], options: { all?: boolean } = {}): WriteTurn {
		let prior: Promise<void> | null = null
		const priors: Array<Promise<void>> = []
		if (this.tails.size > 0 || this.barrier !== null) {
			// A held delete is a barrier: its cascades write other records, so no later write
			// may start before it, whatever record that write touches.
			if (this.barrier) priors.push(this.barrier)
			if (options.all) for (const tail of this.tails.values()) priors.push(tail)
			else
				for (const key of keys) {
					const tail = this.tails.get(key)
					if (tail) priors.push(tail)
				}
			if (priors.length > 0) prior = Promise.all(priors).then(() => {})
		}
		let mine: Promise<void> | null = null
		let open: () => void = () => {}
		const hold = (): void => {
			if (mine) return
			const ours = new Promise<void>((resolve) => {
				open = resolve
			})
			mine = ours
			for (const key of keys) this.tails.set(key, ours)
			if (options.all) this.barrier = ours
		}
		if (prior !== null) hold()
		return {
			wait: prior,
			hold,
			release: () => {
				if (!mine) return
				const ours = mine
				mine = null
				for (const key of keys) if (this.tails.get(key) === ours) this.tails.delete(key)
				if (this.barrier === ours) this.barrier = null
				open()
			},
		}
	}

	/** Whether a write is reading right now (diagnostics and tests). */
	get busy(): boolean {
		return this.tails.size > 0 || this.barrier !== null
	}
}

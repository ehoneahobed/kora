/*
 * Keeps the start order of local updates, deletes and transactions equal to their call order
 * when one of them has to read before it can be predicted (instant-UI stage S6b).
 *
 * A write registers its prediction and starts its storage transaction in ONE synchronous
 * step, so that overlapping writes register in transaction order (design 5.6) and the
 * operation log is the one written with the overlay off (I2). When a prediction first needs
 * a read (the record's row, or the fold state an array write builds on), that step is split
 * by an `await`: a write called later would start first, and `update(id); delete(id)`
 * issued without awaiting would run as delete, update and fail. A write that reads holds
 * the turn; an update, delete or transaction called while a turn is held waits for it, then
 * takes its own. A write that needs no read takes no turn and costs one comparison.
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

/** Per-registry bookkeeping of the writes that are reading. */
export class WriteOrder {
	private tail: Promise<void> | null = null

	/** Call synchronously when a local update, delete or transaction is called. */
	enter(): WriteTurn {
		const prior = this.tail
		let mine: Promise<void> | null = null
		let open: () => void = () => {}
		const hold = (): void => {
			if (mine) return
			mine = new Promise<void>((resolve) => {
				open = resolve
			})
			this.tail = mine
		}
		if (prior !== null) hold()
		return {
			wait: prior,
			hold,
			release: () => {
				if (!mine) return
				const ours = mine
				mine = null
				if (this.tail === ours) this.tail = null
				open()
			},
		}
	}

	/** Whether a write is reading right now (diagnostics and tests). */
	get busy(): boolean {
		return this.tail !== null
	}
}

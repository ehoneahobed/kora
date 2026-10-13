/**
 * An in-process async mutex for a store's operation writes. A store that serves
 * `transact` from one process (SQLite, memory) runs every operation write through it,
 * so a transaction's reads, decision and writes see no other write in between.
 *
 * Not re-entrant: work running under the gate must not wait for the gate again
 * (`transact`'s decision callback must not apply operations itself).
 */
export class WriteGate {
	private tail: Promise<unknown> = Promise.resolve()

	/**
	 * Run `work` once every earlier holder has finished. A failure of one holder does
	 * not affect the next.
	 */
	run<T>(work: () => Promise<T> | T): Promise<T> {
		const result = this.tail.then(work, work)
		this.tail = result.then(
			() => undefined,
			() => undefined,
		)
		return result
	}
}

/**
 * Async mutex for serializing access to a resource across `await` boundaries.
 *
 * This exists because an adapter's `transaction()` is async (its callback may
 * await), but the underlying database transaction (BEGIN…COMMIT) is not
 * reentrant: starting a second transaction while one is open is an error. When
 * a client applies a relayed remote operation while a local write is in flight,
 * the two `transaction()` calls interleave at their `await` points, and without
 * serialization the second `BEGIN` collides with the first, silently dropping
 * the operation. Serializing every transaction through this mutex guarantees at
 * most one is active at a time.
 */
export class Mutex {
	private locked = false
	private readonly waiters: Array<() => void> = []

	/**
	 * Acquire the mutex. Resolves with a release function once the lock is held.
	 * If the mutex is already held, the caller waits (FIFO) until it is released.
	 */
	async acquire(): Promise<() => void> {
		if (!this.locked) {
			this.locked = true
			return this.createRelease()
		}

		return new Promise<() => void>((resolve) => {
			this.waiters.push(() => {
				resolve(this.createRelease())
			})
		})
	}

	private createRelease(): () => void {
		let released = false
		return () => {
			if (released) {
				return
			}
			released = true
			const next = this.waiters.shift()
			if (next) {
				next()
			} else {
				this.locked = false
			}
		}
	}
}

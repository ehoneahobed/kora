/**
 * Counts the read-through reads still waiting for an answer, so the runtime's own downloads
 * can wait for them (first-visit parity S0 P7). On a slow link a navigation's read that leaves
 * just after the runtime starts fetching its storage chunks shares the link with them and takes
 * about twice as long; holding the chunks until the read is answered keeps the screen first.
 */
export interface ReadTracker {
	/** A read was asked for (counted from the ask, before it is sent). */
	begin(): void
	/** That read was answered, failed or withdrawn. */
	end(): void
	/** Settles when no read is waiting, or after `maxMs` at most. */
	idle(maxMs: number): Promise<void>
}

export function createReadTracker(): ReadTracker {
	let pending = 0
	let waiters: Array<() => void> = []
	return {
		begin() {
			pending++
		},
		end() {
			pending = Math.max(0, pending - 1)
			if (pending > 0) return
			const settled = waiters
			waiters = []
			for (const settle of settled) settle()
		},
		idle(maxMs) {
			if (pending === 0) return Promise.resolve()
			// Whichever comes first; a later call of `resolve` does nothing.
			return new Promise<void>((resolve) => {
				setTimeout(resolve, maxMs)
				waiters.push(resolve)
			})
		},
	}
}

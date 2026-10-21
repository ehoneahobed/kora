import { BuildSupersededError, type BuildSupersededInfo } from '../errors'

/** What a refused write was: its collection (when it has one) and its operation. */
export interface WriteScope {
	collection?: string
	operation: string
}

/**
 * Admits writes until the tab is superseded by a newer build (version gate, section 5,
 * steps 2 and 3), and lets retirement wait for every write it admitted.
 *
 * A write is admitted or refused synchronously, when it is called: a refused write never
 * started, so nothing of it is applied. An admitted write is never cancelled: it commits,
 * or fails and rejects to its caller as it would have anyway, and {@link drain} waits for
 * it to settle.
 */
export class WriteGate {
	private refusal: BuildSupersededInfo | null = null
	private readonly inflight = new Set<Promise<unknown>>()

	/**
	 * Run `fn` as one write, or reject with {@link BuildSupersededError} without calling it
	 * when the gate is closed. The check happens before `fn` runs, in the caller's task.
	 */
	run<T>(scope: WriteScope, fn: () => Promise<T>): Promise<T> {
		if (this.refusal !== null) {
			return Promise.reject(new BuildSupersededError(scope, this.refusal))
		}
		let pending: Promise<T>
		try {
			pending = fn()
		} catch (error) {
			return Promise.reject(error)
		}
		this.inflight.add(pending)
		const settle = (): void => {
			this.inflight.delete(pending)
		}
		pending.then(settle, settle)
		return pending
	}

	/** Throws {@link BuildSupersededError} when the gate is closed (synchronous guard). */
	assertOpen(scope: WriteScope): void {
		if (this.refusal !== null) throw new BuildSupersededError(scope, this.refusal)
	}

	/** Refuse every write from now on. Idempotent; the first builds named are kept. */
	close(info: BuildSupersededInfo): void {
		if (this.refusal === null) this.refusal = { ...info }
	}

	/** Whether writes are refused. */
	isClosed(): boolean {
		return this.refusal !== null
	}

	/** Number of admitted writes that have not settled yet. */
	pendingCount(): number {
		return this.inflight.size
	}

	/**
	 * Resolve once every admitted write settled (committed or failed). Never rejects:
	 * a write's failure belongs to its caller. Writes admitted while draining (the gate
	 * still open) are waited for too.
	 */
	async drain(): Promise<void> {
		while (this.inflight.size > 0) {
			await Promise.allSettled([...this.inflight])
		}
	}
}

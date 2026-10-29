import type { OfflineLockManagerLike } from '../../src/offline-tab-coordination'

interface HeldLock {
	name: string
	mode: 'exclusive' | 'shared'
}

interface Waiter {
	name: string
	mode: 'exclusive' | 'shared'
	start: () => void
	reject: (error: unknown) => void
}

function abortError(): Error {
	const error = new Error('aborted')
	error.name = 'AbortError'
	return error
}

/** A hand-driven stand-in for `navigator.locks`: FIFO per name, shared/exclusive, abort. */
export class FakeLockManager implements OfflineLockManagerLike {
	private readonly held: HeldLock[] = []
	private pending: Waiter[] = []

	private canGrant(name: string, mode: 'exclusive' | 'shared'): boolean {
		const same = this.held.filter((lock) => lock.name === name)
		if (same.length === 0) return true
		return mode === 'shared' && same.every((lock) => lock.mode === 'shared')
	}

	private drain(): void {
		const blocked = new Set<string>()
		for (const waiter of [...this.pending]) {
			if (blocked.has(waiter.name)) continue
			if (this.canGrant(waiter.name, waiter.mode)) {
				this.pending = this.pending.filter((w) => w !== waiter)
				waiter.start()
			} else {
				blocked.add(waiter.name)
			}
		}
	}

	request(
		name: string,
		options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean; signal?: AbortSignal },
		callback: (lock: unknown) => unknown,
	): Promise<unknown> {
		const mode = options.mode ?? 'exclusive'
		return new Promise((resolve, reject) => {
			if (options.signal?.aborted) {
				reject(abortError())
				return
			}
			const start = (): void => {
				const lock: HeldLock = { name, mode }
				this.held.push(lock)
				Promise.resolve()
					.then(() => callback({ name, mode }))
					.then(resolve, reject)
					.finally(() => {
						this.held.splice(this.held.indexOf(lock), 1)
						this.drain()
					})
			}
			if (options.ifAvailable && !this.canGrant(name, mode)) {
				Promise.resolve()
					.then(() => callback(null))
					.then(resolve, reject)
				return
			}
			const queued = this.pending.some((waiter) => waiter.name === name)
			if (!queued && this.canGrant(name, mode)) {
				start()
				return
			}
			const waiter: Waiter = { name, mode, start, reject }
			this.pending.push(waiter)
			options.signal?.addEventListener('abort', () => {
				if (!this.pending.includes(waiter)) return
				this.pending = this.pending.filter((w) => w !== waiter)
				reject(abortError())
			})
		})
	}

	async query(): Promise<{
		held: Array<{ name: string; mode: string }>
		pending: Array<{ name: string; mode: string }>
	}> {
		return {
			held: this.held.map((lock) => ({ name: lock.name, mode: lock.mode })),
			pending: this.pending.map((waiter) => ({ name: waiter.name, mode: waiter.mode })),
		}
	}

	/** Hold `name` exclusively until the returned function is called (a tab's tab lock). */
	hold(name: string): { release: () => void } {
		let release: () => void = () => {}
		void this.request(
			name,
			{ mode: 'exclusive' },
			() =>
				new Promise<void>((resolve) => {
					release = resolve
				}),
		)
		return { release: () => release() }
	}

	/** Whether any lock with this name is held right now. */
	isHeld(name: string): boolean {
		return this.held.some((lock) => lock.name === name)
	}
}

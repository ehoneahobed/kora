/**
 * Web Locks per local node id (RT-40). Under per-tab isolation every tab writes under
 * its own node id into one shared database; a live tab holds its node's lock for its
 * lifetime, so another tab can tell a closed tab's node (lock free: adopt its unsynced
 * writes) from a live one (lock held: leave it alone). An adopter holds the lock while
 * it uploads, so two tabs never adopt the same node at once.
 *
 * Without the Web Locks API (Node, workers without it) every node is reported free and
 * acquisition is a no-op: there is no other tab to coordinate with.
 */

interface LockLike {
	name?: string
}

interface LockManagerLike {
	request(
		name: string,
		options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
		callback: (lock: LockLike | null) => Promise<void> | void,
	): Promise<unknown>
	query?(): Promise<{ held?: LockLike[] }>
}

function lockManager(): LockManagerLike | null {
	const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator
	return nav?.locks && typeof nav.locks.request === 'function' ? nav.locks : null
}

/** Lock name of a node id in a database. */
export function nodeLockName(dbName: string, nodeId: string): string {
	return `kora-node:${dbName}:${nodeId}`
}

/**
 * Hold a node's lock until the returned function is called. Acquisition is
 * asynchronous (it waits while an adopter holds the lock); the caller never waits.
 */
export function acquireNodeLock(name: string): () => void {
	const locks = lockManager()
	if (!locks) return () => {}
	let release: () => void = () => {}
	let released = false
	const held = new Promise<void>((resolve) => {
		release = () => {
			released = true
			resolve()
		}
	})
	locks
		.request(name, { mode: 'exclusive' }, async () => {
			if (released) return
			await held
		})
		.catch(() => {
			// A lock that cannot be taken only weakens the liveness hint; never fatal.
		})
	return () => release()
}

/**
 * Take a node's lock only when it is free. Resolves to a release function, or null
 * when another context (a live tab, another adopter) holds it.
 */
export function tryAcquireNodeLock(name: string): Promise<(() => void) | null> {
	const locks = lockManager()
	if (!locks) return Promise.resolve(() => {})
	return new Promise((resolveResult) => {
		let release: () => void = () => {}
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		locks
			.request(name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
				if (!lock) {
					resolveResult(null)
					return
				}
				resolveResult(() => release())
				await held
			})
			.catch(() => resolveResult(null))
	})
}

/** Whether some context holds a node's lock. */
export async function isNodeLockHeld(name: string): Promise<boolean> {
	const locks = lockManager()
	if (!locks?.query) return false
	try {
		const snapshot = await locks.query()
		return (snapshot.held ?? []).some((lock) => lock.name === name)
	} catch {
		return false
	}
}

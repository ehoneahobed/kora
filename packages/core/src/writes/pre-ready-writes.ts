// One slot per JavaScript realm, like the write observer: the binding that opens the scope
// and the app's collection accessor that reads it may come from different copies of this
// module (an ESM and a CJS build in one bundle).
const SLOT = Symbol.for('@korajs/core:pre-ready-writes')

interface PreReadyWritesSlot {
	[SLOT]?: number
}

/**
 * Run `fn` with pre-ready writes allowed, for the synchronous part of `fn` only.
 *
 * A collection write (`app.todos.insert(...)`) made before `app.ready` throws
 * `AppNotReadyError`, because nothing stores it yet and the caller would not know. A
 * framework binding (`useMutation`, `useMutation()` in Vue, the Svelte mutation store)
 * opens this scope around the function it was given: the app then accepts the write,
 * persists it to a small durable journal, applies it as soon as the store opens, and
 * resolves the call's promise only after that. The scope covers the writes `fn` starts
 * before its first `await`, which is when a collection accessor reads it.
 *
 * @param fn - The mutation function of a binding
 * @returns Whatever `fn` returns
 */
export function runAllowingPreReadyWrites<T>(fn: () => T): T {
	const slot = globalThis as PreReadyWritesSlot
	const previous = slot[SLOT] ?? 0
	slot[SLOT] = previous + 1
	try {
		return fn()
	} finally {
		slot[SLOT] = previous
	}
}

/**
 * Whether the code running now is inside {@link runAllowingPreReadyWrites}. A collection
 * accessor calls this synchronously when a write starts before the store is open.
 */
export function preReadyWritesAllowed(): boolean {
	return ((globalThis as PreReadyWritesSlot)[SLOT] ?? 0) > 0
}

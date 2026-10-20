import type { Operation } from '../types'

/**
 * Receives the operations of local writes started while it is the current observer.
 * Used by framework bindings to learn which operations one `mutate()` call produced,
 * so a later server refusal can be reported to the hook that made the write.
 */
export interface WriteObserver {
	/**
	 * Called once per committed local write (a single insert/update/delete with its
	 * referential side effects, or a whole transaction), after the storage transaction
	 * commits and before the operations are published to sync. Must not throw.
	 */
	onOperations(operations: readonly Operation[]): void
}

// One slot per JavaScript realm, shared by every copy of this module (a bundle may hold
// an ESM and a CJS copy of @korajs/core): the binding that sets it and the store that
// reads it must agree on the slot.
const SLOT = Symbol.for('@korajs/core:write-observer')

interface ObserverSlot {
	[SLOT]?: WriteObserver | null
}

/**
 * Run `fn` with `observer` as the current write observer, for the synchronous part of
 * `fn` only. A local write captures the observer when it starts (synchronously), so the
 * writes `fn` starts before its first `await` are attributed to `observer`; writes it
 * starts later are not. Passing `null` shields `fn` from an enclosing observer.
 *
 * @returns Whatever `fn` returns
 */
export function runWithWriteObserver<T>(observer: WriteObserver | null, fn: () => T): T {
	const slot = globalThis as ObserverSlot
	const previous = slot[SLOT] ?? null
	slot[SLOT] = observer
	try {
		return fn()
	} finally {
		slot[SLOT] = previous
	}
}

/**
 * The write observer of the code running now, or null. Local write entry points call
 * this synchronously when they start and report their committed operations to it.
 */
export function currentWriteObserver(): WriteObserver | null {
	return (globalThis as ObserverSlot)[SLOT] ?? null
}

/**
 * Report committed operations to an observer without letting a faulty observer fail the
 * write that already committed: an error is rethrown asynchronously (reported, never
 * swallowed) instead.
 */
export function notifyWriteObserver(
	observer: WriteObserver | null,
	operations: readonly Operation[],
): void {
	if (!observer || operations.length === 0) return
	try {
		observer.onOperations(operations)
	} catch (error) {
		queueMicrotask(() => {
			throw error
		})
	}
}

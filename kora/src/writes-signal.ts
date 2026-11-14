/**
 * The writes signal: how many local writes are still being committed, for code on the page
 * that this package cannot import, chiefly the offline shell's registration script
 * (`koraServiceWorker()` in `@korajs/cli/vite`). Accepting a new version reloads the page, and a
 * reload while a write is in flight can lose a sale the user already saw on screen, so the
 * script waits until this reports zero.
 *
 * The contract, beside `__KORA_FIRST_DATA__`: `globalThis.__KORA_WRITES__ = { v: 1, pending,
 * settled }`, where `pending()` is the number of unsettled writes and `settled()` resolves once
 * they (and any started meanwhile) have settled. Per page; the first app created owns it.
 */

/** The page-global state of the signal. */
export interface WritesSignal {
	v: 1
	/** Writes admitted and not yet settled (committed or failed). */
	pending(): number
	/** Resolves when no admitted write is unsettled. Never rejects. */
	settled(): Promise<void>
}

/** What the signal reads: the app's store once it is open, or null before that. */
export interface WritesSource {
	pendingWriteCount(): number
	whenWritesSettled(): Promise<void>
}

/**
 * Publishes the signal on `target` unless an earlier app on the page did.
 *
 * @param store - Returns the open store, or null while none is open (no writes yet)
 * @param target - The page (tests pass a fake). Defaults to `globalThis`.
 * @returns Whether this app published it
 */
export function publishWritesSignal(
	store: () => WritesSource | null,
	target: { __KORA_WRITES__?: unknown } = globalThis as { __KORA_WRITES__?: unknown },
): boolean {
	if (target.__KORA_WRITES__ !== undefined) return false
	const signal: WritesSignal = {
		v: 1,
		pending: () => store()?.pendingWriteCount() ?? 0,
		settled: () => store()?.whenWritesSettled() ?? Promise.resolve(),
	}
	target.__KORA_WRITES__ = signal
	return true
}

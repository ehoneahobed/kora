/**
 * Listeners that were added before the runtime they belong to existed. Each `add` attaches
 * at once when the target is available; `flush` attaches the rest when it becomes so.
 */
export class LateSubscriptions {
	private readonly entries = new Set<{
		attach: () => (() => void) | null
		detach: (() => void) | null
		notify: (() => void) | null
	}>()

	/**
	 * @param notify - Tells the listener the current value; run by `flush(true)` once the
	 *   runtime is open. Omit for a subscription that has no value to catch up on.
	 */
	add(notify: (() => void) | null, attach: () => (() => void) | null): () => void {
		const entry = { attach, detach: attach(), notify }
		this.entries.add(entry)
		return () => {
			entry.detach?.()
			entry.detach = null
			this.entries.delete(entry)
		}
	}

	flush(notify = false): void {
		for (const entry of [...this.entries]) {
			if (entry.detach === null) entry.detach = entry.attach()
			if (notify && entry.notify) {
				try {
					entry.notify()
				} catch (error) {
					console.error('[kora] A subscriber threw while catching up on the opened app:', error)
				}
			}
		}
	}
}

/**
 * Wraps a listener so it only hears a value that differs from the last one it was given. The
 * runtime delivers the current value when a listener attaches and `flush(true)` delivers it
 * again once the app opened; when nothing changed between the placeholder and the real value
 * the second call would be noise (and a re-render for no reason).
 */
export function onlyChanges<T>(listener: (value: T) => void): (value: T) => void {
	let last: string | undefined
	return (value) => {
		let key: string | undefined
		try {
			key = JSON.stringify(value)
		} catch {
			// A value with no JSON form cannot be compared: deliver it.
			key = undefined
		}
		if (key !== undefined && key === last) return
		last = key
		listener(value)
	}
}

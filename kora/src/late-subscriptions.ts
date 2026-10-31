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

/**
 * An in-process async mutex for a store's operation writes. A store that serves
 * `transact` from one process (SQLite, memory) runs every operation write through it,
 * so a transaction's reads, decision and writes see no other write in between.
 *
 * Not re-entrant: work running under the gate must not wait for the gate again
 * (`transact`'s decision callback must not apply operations itself).
 */
export class WriteGate {
	private tail: Promise<unknown> = Promise.resolve()

	/**
	 * Run `work` once every earlier holder has finished. A failure of one holder does
	 * not affect the next.
	 */
	run<T>(work: () => Promise<T> | T): Promise<T> {
		const result = this.tail.then(work, work)
		this.tail = result.then(
			() => undefined,
			() => undefined,
		)
		return result
	}
}

/**
 * `store` with its blob ownership writes recorded: every owner a decision adds
 * (`claimBlobIfUnowned`, `recordBlobOwner`) that it did not hold before is reported to
 * `onAdded`, so a transaction that commits nothing can remove them again. Other calls
 * pass through.
 */
export function recordingBlobOwners<T extends object>(
	store: T & {
		getBlobOwners?(hashes: string[]): Promise<Map<string, string[]>>
		claimBlobIfUnowned?(hash: string, owner: string): Promise<boolean>
		recordBlobOwner?(hash: string, owner: string): Promise<void>
	},
	onAdded: (hash: string, owner: string) => void,
): T {
	const heldBefore = async (hash: string, owner: string): Promise<boolean> =>
		((await store.getBlobOwners?.([hash]))?.get(hash) ?? []).includes(owner)
	const view: T = new Proxy(store, {
		get: (target, property) => {
			if (property === 'claimBlobIfUnowned' && target.claimBlobIfUnowned) {
				return async (hash: string, owner: string): Promise<boolean> => {
					const held = await heldBefore(hash, owner)
					const granted = await target.claimBlobIfUnowned?.(hash, owner)
					if (granted && !held) onAdded(hash, owner)
					return granted === true
				}
			}
			if (property === 'recordBlobOwner' && target.recordBlobOwner) {
				return async (hash: string, owner: string): Promise<void> => {
					const held = await heldBefore(hash, owner)
					await target.recordBlobOwner?.(hash, owner)
					if (!held) onAdded(hash, owner)
				}
			}
			const value: unknown = Reflect.get(target, property, target)
			return typeof value === 'function'
				? (value as (...args: unknown[]) => unknown).bind(view)
				: value
		},
		set: (target, property, value) => Reflect.set(target, property, value, target),
	})
	return view
}

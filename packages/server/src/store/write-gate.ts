import { STORE_IDENTITY, type ServerStore, storeIdentity } from './server-store'

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

/** A blob ownership a decision would add, written only when its set commits. */
export interface StagedBlobOwner {
	hash: string
	owner: string
	/** `claim`: only if the hash has no owner at commit; `record`: added in any case. */
	kind: 'claim' | 'record'
}

/**
 * `store` with its blob ownership writes staged instead of written: `claimBlobIfUnowned`
 * and `recordBlobOwner` answer as if they had written (reads of owners include what is
 * staged) and push the change to `staged`, which the store writes in the same
 * transaction as the operations, or drops. Other calls pass through.
 */
export function stagingBlobOwners<T extends object>(
	store: T & {
		getBlobOwners?(hashes: string[]): Promise<Map<string, string[]>>
		claimBlobIfUnowned?(hash: string, owner: string): Promise<boolean>
		recordBlobOwner?(hash: string, owner: string): Promise<void>
	},
	staged: StagedBlobOwner[],
): T {
	const ownersOf = async (hashes: string[]): Promise<Map<string, string[]>> => {
		const stored = (await store.getBlobOwners?.(hashes)) ?? new Map<string, string[]>()
		const out = new Map<string, string[]>()
		for (const hash of hashes) {
			const owners = new Set(stored.get(hash) ?? [])
			for (const change of staged) if (change.hash === hash) owners.add(change.owner)
			out.set(hash, [...owners])
		}
		return out
	}
	const view: T = new Proxy(store, {
		get: (target, property) => {
			if (property === STORE_IDENTITY) return storeIdentity(target as unknown as ServerStore)
			if (property === 'getBlobOwners' && target.getBlobOwners) return ownersOf
			if (property === 'claimBlobIfUnowned' && target.claimBlobIfUnowned) {
				return async (hash: string, owner: string): Promise<boolean> => {
					const owners = (await ownersOf([hash])).get(hash) ?? []
					if (owners.length > 0) return owners.includes(owner)
					staged.push({ hash, owner, kind: 'claim' })
					return true
				}
			}
			if (property === 'recordBlobOwner' && target.recordBlobOwner) {
				return async (hash: string, owner: string): Promise<void> => {
					staged.push({ hash, owner, kind: 'record' })
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

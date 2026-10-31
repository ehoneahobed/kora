import { AppNotReadyError } from '../errors/errors'

const PENDING_STORES = new WeakSet<object>()

/**
 * Whether `store` is a stand-in made by {@link createPendingStore}, so a binding can tell
 * "the database is still opening" from "the database is open".
 *
 * @param store - A store from a binding's context
 * @returns True while the app's store has not opened
 */
export function isPendingStore(store: unknown): boolean {
	return typeof store === 'object' && store !== null && PENDING_STORES.has(store)
}

/**
 * The store handed to framework bindings while `app.ready` is still pending.
 *
 * `KoraProvider` renders its children before the database opens, so a component can ask
 * its context for a store at that moment. This stand-in answers the one thing that works
 * before the store exists: `collection(name)` returns the app's own collection accessor
 * (deferred queries, queued writes). Everything else throws {@link AppNotReadyError} when
 * it is used, with the fix in the message. After `app.ready` the binding swaps in the real
 * store.
 *
 * @param collections - `app.collections`, the accessors that work before `app.ready`
 * @returns An object typed as the framework's store
 */
export function createPendingStore<TStore>(collections: object | undefined): TStore {
	const notReady = (member: string): AppNotReadyError =>
		new AppNotReadyError(
			`store.${member} is not available before app.ready. Await app.ready, or render this part of the tree only once the store is open (<KoraProvider waitForStorage>).`,
		)
	const pending = new Proxy(Object.create(null) as object, {
		get(_target, property) {
			// Not a promise, not serializable, not iterable: probes by the runtime or devtools.
			if (typeof property === 'symbol' || property === 'then' || property === 'toJSON') {
				return undefined
			}
			if (property === 'collection') {
				return (name: string): unknown => {
					const accessor = (collections as Readonly<Record<string, unknown>> | undefined)?.[name]
					if (accessor === undefined) {
						throw new AppNotReadyError(
							`Collection "${name}" is not available before app.ready, or it is not in the schema.`,
						)
					}
					return accessor
				}
			}
			return () => {
				throw notReady(String(property))
			}
		},
	})
	PENDING_STORES.add(pending)
	return pending as TStore
}

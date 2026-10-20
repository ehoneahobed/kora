import type { Operation } from '@korajs/core'
import { currentWriteObserver, runWithWriteObserver } from '@korajs/core/internal'
import type { Store } from '@korajs/store'
import type { KoraConfig, TransactionProxy } from './types'

export type TransactionExecutor = (
	fn: (tx: TransactionProxy) => Promise<void>,
	mutationName?: string,
) => Promise<Operation[]>

/**
 * Creates the shared executor used by {@link KoraApp.transaction} and {@link KoraApp.mutation}.
 */
export function createTransactionExecutor(
	config: KoraConfig,
	ready: Promise<void>,
	getStore: () => Store | null,
): TransactionExecutor {
	return async (fn, mutationName) => {
		// `await ready` ends the synchronous span the caller's write observer (a binding's
		// mutate()) is current in: carry it across to the store transaction.
		const observer = currentWriteObserver()
		await ready
		const store = getStore()
		if (!store) {
			throw new Error('Store not initialized. Await app.ready before using transactions.')
		}

		const collectionNames = Object.keys(config.schema.collections)

		return runWithWriteObserver(observer, () =>
			store.transaction(async (tx) => {
				if (mutationName !== undefined) {
					tx.setMutationName(mutationName)
				}

				const proxy: TransactionProxy = {} as TransactionProxy
				for (const name of collectionNames) {
					Object.defineProperty(proxy, name, {
						get() {
							return tx.collection(name)
						},
						enumerable: true,
						configurable: false,
					})
				}

				await fn(proxy)
			}),
		)
	}
}

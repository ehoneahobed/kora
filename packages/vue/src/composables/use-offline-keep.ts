import {
	type OfflineKeepHold,
	type OfflineKeepOptions,
	type OfflineKeepQuery,
	canonicalOfflinePinKey,
	holdOfflineKeep,
	toOfflinePinSpec,
} from '@korajs/core/bindings'
import { onScopeDispose, readonly, shallowRef, watch } from 'vue'
import { useKoraContext } from '../context'

/**
 * Keep the records a query matches on this device while the component (or effect scope) is
 * alive, so the app is `ready` for offline use with them (`app.offline.keep`, as a hold).
 *
 * Pass a getter when the query depends on reactive state: the hold follows it, releasing the
 * old pin and taking the new one. Several components may hold the same query; the pin stays
 * until the last one is gone. The query is one collection's `where` (no `limit`, `offset` or
 * `include`); `{ files: true }` also keeps the files of its records.
 *
 * @param query - A query, or a getter returning one
 * @param options - `{ files }`
 * @returns Readonly refs: `held` once the pin is recorded on this device, and `error` when
 * it was refused (an unsupported query, the 64-pin limit)
 */
export function useOfflineKeep(
	query: OfflineKeepQuery | (() => OfflineKeepQuery),
	options?: OfflineKeepOptions,
) {
	const { app } = useKoraContext()
	const offline = app?.offline
	const held = shallowRef(false)
	const error = shallowRef<Error | null>(null)
	const read = (): OfflineKeepQuery => (typeof query === 'function' ? query() : query)

	let hold: OfflineKeepHold | null = null
	const drop = (): void => {
		hold?.release()
		hold = null
		held.value = false
	}

	if (offline?.hold) {
		const keeper = offline as { hold: NonNullable<typeof offline.hold> }
		watch(
			() => {
				try {
					return canonicalOfflinePinKey(toOfflinePinSpec(read(), options))
				} catch (invalid) {
					error.value = invalid instanceof Error ? invalid : new Error(String(invalid))
					return null
				}
			},
			(key, _previous, onCleanup) => {
				if (key === null) return
				error.value = null
				const mine = holdOfflineKeep(keeper, read(), options)
				hold = mine
				mine.recorded.then(
					() => {
						if (hold === mine) held.value = true
					},
					(failure: unknown) => {
						if (hold === mine) {
							error.value = failure instanceof Error ? failure : new Error(String(failure))
						}
					},
				)
				onCleanup(drop)
			},
			{ immediate: true },
		)
	}
	onScopeDispose(drop)
	return { held: readonly(held), error: readonly(error) }
}

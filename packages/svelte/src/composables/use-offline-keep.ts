import {
	type OfflineKeepHold,
	type OfflineKeepOptions,
	type OfflineKeepQuery,
	holdOfflineKeep,
} from '@korajs/core/bindings'
import { onDestroy } from 'svelte'
import { type Readable, readable, writable } from 'svelte/store'
import { getKoraContext } from '../context'

/** What {@link createOfflineKeepStore} returns. */
export interface OfflineKeepStore {
	/** `held`: the pin is recorded on this device; `error`: why it was refused, or null. */
	subscribe: Readable<{ held: boolean; error: Error | null }>['subscribe']
	/** Release the hold now (it is released when the component is destroyed anyway). */
	release(): void
}

/**
 * Keep the records a query matches on this device while the component is alive, so the app
 * is `ready` for offline use with them (`app.offline.keep`, as a hold). Call it while the
 * component initializes: the hold is released in `onDestroy`. Outside a component the caller
 * owns the hold and calls `release()`.
 *
 * Several components may hold the same query; the pin stays until the last one is gone.
 * The query is one collection's `where` (no `limit`, `offset` or `include`); `{ files: true }`
 * also keeps the files of its records.
 *
 * @param query - For example `app.lessons.where({ courseId })`
 * @param options - `{ files }`
 */
export function createOfflineKeepStore(
	query: OfflineKeepQuery,
	options?: OfflineKeepOptions,
): OfflineKeepStore {
	const { app } = getKoraContext()
	const offline = app?.offline
	const state = writable<{ held: boolean; error: Error | null }>({ held: false, error: null })
	let hold: OfflineKeepHold | null = null

	if (offline?.hold) {
		const mine = holdOfflineKeep(
			offline as { hold: NonNullable<typeof offline.hold> },
			query,
			options,
		)
		hold = mine
		mine.recorded.then(
			() => {
				if (hold === mine) state.set({ held: true, error: null })
			},
			(failure: unknown) => {
				if (hold === mine) {
					state.set({
						held: false,
						error: failure instanceof Error ? failure : new Error(String(failure)),
					})
				}
			},
		)
	}

	const release = (): void => {
		hold?.release()
		hold = null
		state.update((previous) => (previous.held ? { held: false, error: null } : previous))
	}
	try {
		onDestroy(release)
	} catch {
		// Not inside a component initialization: the caller owns the hold.
	}
	return { subscribe: state.subscribe, release }
}

/** Alias for {@link createOfflineKeepStore}. */
export const useOfflineKeep = createOfflineKeepStore

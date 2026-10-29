import {
	type OfflineKeepOptions,
	type OfflineKeepQuery,
	canonicalOfflinePinKey,
	holdOfflineKeep,
	toOfflinePinSpec,
} from '@korajs/core/bindings'
import { useEffect, useRef, useState } from 'react'
import { useKoraContext } from '../context/kora-context'

/** What {@link useOfflineKeep} reports. */
export interface UseOfflineKeepResult {
	/** True once the pin is durably recorded on this device. */
	held: boolean
	/** Why the pin was refused (an unsupported query, the 64-pin limit), or null. */
	error: Error | null
}

/**
 * Keep the records a query matches on this device for as long as the component is mounted,
 * so the app is `ready` for offline use with them (`app.offline.keep`, as a hold).
 *
 * Several components may hold the same query, in one tab or several: the pin stays until
 * the last one unmounts (and any explicit `app.offline.keep()` released it). React
 * StrictMode's double mount leaves one hold. A tab that closes without unmounting is
 * pruned by the tabs still open. The query is one collection's `where` (no `limit`,
 * `offset` or `include`); `{ files: true }` also keeps the files of its records.
 *
 * @param query - For example `app.lessons.where({ courseId })`
 * @param options - `{ files }`
 * @returns Whether the pin is recorded, and why not when it was refused
 *
 * @example
 * ```tsx
 * function Course({ courseId }: { courseId: string }) {
 *   useOfflineKeep(app.lessons.where({ courseId }), { files: true })
 *   return <Lessons courseId={courseId} />
 * }
 * ```
 */
export function useOfflineKeep(
	query: OfflineKeepQuery,
	options?: OfflineKeepOptions,
): UseOfflineKeepResult {
	const { app } = useKoraContext()
	const offline = app?.offline
	const [state, setState] = useState<UseOfflineKeepResult>({ held: false, error: null })

	// The pin, not the query object, is what the effect depends on: `app.lessons.where(...)`
	// is a new object on every render.
	let key: string | null = null
	let invalid: Error | null = null
	try {
		key = canonicalOfflinePinKey(toOfflinePinSpec(query, options))
	} catch (error) {
		invalid = error instanceof Error ? error : new Error(String(error))
	}
	const latest = useRef({ query, options })
	latest.current = { query, options }

	useEffect(() => {
		if (key === null || !offline?.hold) return undefined
		const hold = holdOfflineKeep(
			offline as { hold: NonNullable<typeof offline.hold> },
			latest.current.query,
			latest.current.options,
		)
		let current = true
		hold.recorded.then(
			() => {
				if (current) setState({ held: true, error: null })
			},
			(error: unknown) => {
				if (current)
					setState({
						held: false,
						error: error instanceof Error ? error : new Error(String(error)),
					})
			},
		)
		return () => {
			current = false
			hold.release()
			setState((previous) =>
				previous.held || previous.error ? { held: false, error: null } : previous,
			)
		}
	}, [offline, key])

	return invalid ? { held: false, error: invalid } : state
}

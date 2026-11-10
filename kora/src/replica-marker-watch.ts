/**
 * Records that this device's replica completed (see `./replica-marker`). It runs once the store
 * is open, so it loads with a dynamic `import()` and stays out of the first paint's JavaScript.
 */
import { COMPLETE_PREFIX, databaseEpoch, storage } from './replica-marker'

function recordCompletedReplica(dbName: string): void {
	const epoch = databaseEpoch(dbName)
	if (epoch === null) return
	try {
		storage()?.setItem(`${COMPLETE_PREFIX}${dbName}`, epoch)
	} catch {
		// Quota or blocked storage: the next visit reads through, as a first visit does.
	}
}

/** What {@link watchCompletedReplica} reads. */
export interface CompletedReplicaWatch {
	dbName: string
	/** The database's completion marks. */
	loadMarks: () => Promise<{ marks: readonly unknown[] }>
	/** Subscribes to sync status; absent when the app does not sync. */
	subscribeStatus?: (listener: (status: { activeViewComplete?: boolean }) => void) => () => void
}

/**
 * Records the replica as completed once the open database holds a completion mark: at once for
 * a device that completed earlier, otherwise when the active view is first complete.
 *
 * @returns A function that stops watching
 */
export function watchCompletedReplica(options: CompletedReplicaWatch): () => void {
	let done = false
	let checking = false
	let unsubscribe: (() => void) | undefined
	const stop = (): void => {
		done = true
		unsubscribe?.()
		unsubscribe = undefined
	}
	const check = (): void => {
		if (done || checking) return
		checking = true
		// Through a promise: the store throws synchronously once the app has closed.
		Promise.resolve()
			.then(options.loadMarks)
			.then(
				({ marks }) => {
					checking = false
					if (done || marks.length === 0) return
					recordCompletedReplica(options.dbName)
					stop()
				},
				() => {
					// Advisory: a failed read leaves this device reading through, as a first visit does.
					checking = false
				},
			)
	}
	unsubscribe = options.subscribeStatus?.((status) => {
		if (status.activeViewComplete === true) check()
	})
	check()
	return stop
}

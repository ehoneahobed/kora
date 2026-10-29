import type {
	OfflineKeepOptions,
	OfflineKeepQuery,
	OfflineKeepRelease,
} from '../offline/offline-keep'

/** A component's hold on a pin, as the framework bindings use it. */
export interface OfflineKeepHold {
	/** Settles when the pin is durably recorded; rejects with the reason it was refused. */
	recorded: Promise<void>
	/** Release the hold. Safe to call before `recorded` settles, and more than once. */
	release(): void
}

/**
 * Hold a pin for a component's lifetime (`useOfflineKeep` in every binding). The release
 * waits for the hold to be recorded, so an unmount that races the write (React StrictMode's
 * mount, unmount, mount) releases exactly the hold it took and never another component's.
 *
 * @param offline - `app.offline`
 * @param query - The query to keep
 * @param options - `{ files }`
 * @param onError - Called when releasing the hold fails (default: logged)
 */
export function holdOfflineKeep(
	offline: {
		hold(query: OfflineKeepQuery, options?: OfflineKeepOptions): Promise<OfflineKeepRelease>
	},
	query: OfflineKeepQuery,
	options?: OfflineKeepOptions,
	onError: (error: unknown) => void = (error) => {
		console.error('[kora] Releasing an offline keep hold failed:', error)
	},
): OfflineKeepHold {
	let released = false
	let release: OfflineKeepRelease | null = null
	const recorded = offline.hold(query, options).then((held) => {
		release = held
		// Released before the write finished: undo it now that it can be.
		if (released) void held().catch(onError)
	})
	return {
		recorded,
		release() {
			if (released) return
			released = true
			if (release) void release().catch(onError)
		},
	}
}

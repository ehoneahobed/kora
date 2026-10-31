import type { AuthSyncBinding, AuthSyncState, OfflineRestoreResult } from '@korajs/core/bindings'

/**
 * Builds an {@link AuthSyncBinding} whose real implementation is loaded on first use.
 *
 * The auth client and `createKoraAuthSync` are about 11 KB of gzip JavaScript that the first
 * paint does not need: the task list renders from the local database, and the sign-in state
 * only fills a button. Pass a loader that dynamically imports the module that builds the
 * binding and the code leaves the critical path. Sync still waits for it (every method
 * resolves after the load), so nothing connects, refreshes a token or judges the session
 * before the real binding exists.
 *
 * A failed load (a dropped chunk request) is not remembered: the next call tries again, and
 * the failure reaches the caller of that one call, which sync already treats as a retriable
 * auth error.
 *
 * Methods the loaded binding does not have degrade the way an absent method does for a
 * binding used directly: no scope map, no node id and no user id, and a session that is
 * never reported as restorable offline.
 *
 * @param load - Loads the real binding, e.g. `() => import('./auth-runtime').then((m) => m.binding)`
 * @returns A binding to pass as `sync.authClient`
 *
 * @example
 * ```typescript
 * const app = createApp({
 *   schema,
 *   sync: {
 *     url,
 *     authClient: lazyAuthSync(() => import('./auth-sync').then((m) => m.authSync)),
 *   },
 * })
 * ```
 */
export function lazyAuthSync(load: () => Promise<AuthSyncBinding>): AuthSyncBinding {
	let loaded: Promise<AuthSyncBinding> | null = null
	const real = (): Promise<AuthSyncBinding> => {
		if (loaded === null) {
			const attempt = load()
			loaded = attempt
			// A failed attempt must not poison later calls.
			attempt.catch(() => {
				if (loaded === attempt) loaded = null
			})
		}
		return loaded
	}

	return {
		auth: async (options) => (await real()).auth(options),
		resolveSyncState: async (): Promise<AuthSyncState> => {
			const binding = await real()
			if (binding.resolveSyncState) return binding.resolveSyncState()
			// A binding with no sync state: a token means a session, none means signed out.
			const { token } = await binding.auth()
			const userId = await binding.resolveUserId?.()
			if (token && userId) return { state: 'authenticated', userId, token }
			return { state: 'signed-out', mayConnectAnonymously: false }
		},
		resolveScopeMap: async () => (await real()).resolveScopeMap?.(),
		resolveNodeId: async () => (await real()).resolveNodeId?.(),
		resolveUserId: async () => (await real()).resolveUserId?.(),
		resolveOfflineRestore: async (): Promise<OfflineRestoreResult> => {
			const binding = await real()
			if (binding.resolveOfflineRestore) return binding.resolveOfflineRestore()
			return { restorable: 'unknown', reason: 'credential-durability-unknown' }
		},
		subscribe: (listener) => {
			let active = true
			let detach: () => void = () => {}
			real().then(
				(binding) => {
					if (!active) return
					if (binding.subscribe) detach = binding.subscribe(listener)
					// Whoever subscribed read an answer from a binding that did not exist yet.
					listener()
				},
				() => {
					// The load failed: a later call retries it, and the failure is already
					// reported to whichever call needed the binding.
				},
			)
			return () => {
				active = false
				detach()
			}
		},
	}
}

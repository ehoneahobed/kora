import type { AuthSyncBinding, AuthSyncState, OfflineRestoreResult } from '@korajs/core/bindings'
import { KoraError } from '@korajs/core/lite'

/**
 * The sign-in client's chunk could not be loaded (not an error the auth backend raised).
 * Initialization tolerates exactly this; a failure inside the loaded client still fails `ready`.
 */
export class AuthClientLoadError extends KoraError {
	constructor(cause: unknown) {
		super(
			`The sign-in client could not be loaded: ${cause instanceof Error ? cause.message : cause}`,
			'AUTH_CLIENT_LOAD_FAILED',
		)
	}
}

function startLoad(load: () => Promise<AuthSyncBinding>): Promise<AuthSyncBinding> {
	// Called directly (not through an async wrapper) so a failure is observed one microtask
	// after it happens, before any caller can see the rejected promise.
	try {
		return load()
	} catch (error) {
		return Promise.reject(error)
	}
}

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
	/** Subscribers: attached to the real binding once one exists, and re-attached after a failed load. */
	interface Subscriber {
		listener: () => void
		active: boolean
		detach: (() => void) | null
	}
	const subscribers = new Set<Subscriber>()
	const attachWaiting = (binding: AuthSyncBinding): void => {
		for (const subscriber of subscribers) {
			if (!subscriber.active || subscriber.detach !== null) continue
			subscriber.detach = binding.subscribe ? binding.subscribe(subscriber.listener) : () => {}
			// Whoever subscribed read an answer from a binding that did not exist yet.
			subscriber.listener()
		}
	}
	const real = (): Promise<AuthSyncBinding> => {
		if (loaded === null) {
			// A failed attempt must not poison later calls, nor lose the subscribers: it forgets
			// itself before anyone can observe the rejection, and the subscribers attach when a
			// later call loads the binding.
			const attempt: Promise<AuthSyncBinding> = startLoad(load).catch((error: unknown) => {
				if (loaded === attempt) loaded = null
				throw new AuthClientLoadError(error)
			})
			loaded = attempt
			attempt.then(attachWaiting, () => {})
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
			const subscriber: Subscriber = { listener, active: true, detach: null }
			subscribers.add(subscriber)
			// Triggers the load; the subscriber attaches when it succeeds (now or on a retry).
			real().then(attachWaiting, () => {})
			return () => {
				subscriber.active = false
				subscribers.delete(subscriber)
				subscriber.detach?.()
			}
		},
	}
}

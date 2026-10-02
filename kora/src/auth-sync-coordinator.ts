import type { AuthSyncState } from '@korajs/core/bindings'
import type { SyncEngine } from '@korajs/sync'
import type { AuthSyncBinding } from './types'

/**
 * The auth state as the sync TRANSPORT sees it. An authenticated-offline
 * session (identity known, no fresh token) keeps the local store open but must
 * not open a transport: handshaking with an empty or expired token would be
 * rejected (or, against a mixed-auth server, treated as anonymous). It is
 * reported to the engine as still loading, and the auth binding's subscribe
 * wakes sync once a fresh token exists.
 *
 * @param binding - The app's auth sync binding
 * @returns A resolver suitable for the sync engine's `authState`, or undefined
 */
export function transportAuthState(
	binding: AuthSyncBinding | null,
): (() => Promise<AuthSyncState>) | undefined {
	const resolve = binding?.resolveSyncState
	if (!resolve) return undefined
	return async () => {
		const state = await resolve()
		return state.state === 'authenticated' && !state.token ? { state: 'loading' } : state
	}
}

/**
 * The signed-in user as the auth binding reports it (RT-42): a user id when
 * authenticated (online or offline), null when signed out or anonymous, undefined while
 * auth is still loading or when the binding cannot tell.
 *
 * @param binding - The app's auth sync binding
 * @returns A resolver for the sync engine's `principal`, or undefined
 */
export function authPrincipal(
	binding: AuthSyncBinding | null,
): (() => Promise<string | null | undefined>) | undefined {
	if (!binding) return undefined
	const { resolveSyncState, resolveUserId } = binding
	if (resolveSyncState) {
		return async () => {
			const state = await resolveSyncState()
			if (state.state === 'authenticated') return state.userId
			if (state.state === 'loading') return undefined
			return null
		}
	}
	if (resolveUserId) return async () => (await resolveUserId()) ?? undefined
	return undefined
}

/**
 * Serializes auth-driven sync reconnects so overlapping token refresh events
 * do not stack concurrent stop/start cycles on the sync engine.
 */
export class AuthSyncCoordinator {
	private inFlight: Promise<void> | null = null
	private pending = false
	private disposed = false

	constructor(
		private readonly getEngine: () => SyncEngine | null,
		private readonly authBinding: AuthSyncBinding,
	) {}

	scheduleReconnect(): void {
		if (this.disposed) {
			return
		}

		// Bind the store to the user the binding reports NOW, outside the serialized
		// reconnect (RT-52): a run already in flight can take as long as a credential
		// fetch plus the transport's connect timeout, and every write made meanwhile must be
		// authored under the new user's node. The run notices the change before its
		// handshake and starts over.
		const engine = this.getEngine()
		void engine?.bindSignedInUser?.().catch((error: unknown) => {
			console.warn(
				`[kora] binding local writes to the signed-in user failed: ${error instanceof Error ? error.message : String(error)}`,
			)
		})

		if (this.inFlight) {
			this.pending = true
			return
		}

		this.inFlight = this.run().finally(() => {
			this.inFlight = null
			if (this.pending && !this.disposed) {
				this.pending = false
				this.scheduleReconnect()
			}
		})
	}

	destroy(): void {
		this.disposed = true
		this.pending = false
	}

	private async run(): Promise<void> {
		const engine = this.getEngine()
		if (!engine) {
			return
		}
		engine.notifyAuthChanged?.()
		// Another user signed in: the next local write must be authored under that user's
		// node, and the previous user's session must not upload it (RT-42).
		await engine.refreshPrincipal?.()

		const authState = await transportAuthState(this.authBinding)?.()
		if (authState?.state === 'loading' || authState?.state === 'signed-out') {
			await engine.stop()
			await engine.start() // records the suspended state without opening a transport
			return
		}
		const headers = await this.authBinding.auth()
		if (!headers.token && authState?.state !== 'anonymous') {
			await engine.stop()
			return
		}

		if (this.authBinding.resolveScopeMap) {
			const nextScope = await this.authBinding.resolveScopeMap()
			engine.updateScope(nextScope)
		}

		const status = engine.getStatus().status
		if (status !== 'offline') {
			await engine.reconnect()
			return
		}
		await engine.start()
	}
}

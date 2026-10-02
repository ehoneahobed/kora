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

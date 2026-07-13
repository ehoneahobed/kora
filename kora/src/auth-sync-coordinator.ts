import type { SyncEngine } from '@korajs/sync'
import type { AuthSyncBinding } from './types'

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

		const headers = await this.authBinding.auth()
		if (!headers.token) {
			await engine.stop()
			return
		}

		if (this.authBinding.resolveScopeMap) {
			const nextScope = await this.authBinding.resolveScopeMap()
			engine.updateScope(nextScope)
		}

		const status = engine.getStatus().status
		if (status !== 'offline') {
			await engine.stop()
		}
		await engine.start()
	}
}

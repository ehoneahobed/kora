import type { SyncStatusInfo } from '@korajs/sync'
import { OFFLINE_SYNC_STATUS } from '@korajs/sync'
import type { SyncRuntimeState } from './sync-lifecycle'
import type { KoraConfig, SyncControl } from './types'

export interface CreateSyncControlOptions {
	config: KoraConfig
	ready: Promise<void>
	state: SyncRuntimeState
}

/**
 * Builds the developer-facing `app.sync` control surface.
 */
export function createSyncControl(options: CreateSyncControlOptions): SyncControl | null {
	const { config, ready, state } = options

	if (!config.sync) {
		return null
	}

	const offlineSyncStatus = (): SyncStatusInfo => OFFLINE_SYNC_STATUS

	const bridgeStatus = (): SyncStatusInfo =>
		state.syncStatusBridge?.status ?? offlineSyncStatus()

	return {
		get status(): SyncStatusInfo {
			return bridgeStatus()
		},
		subscribeStatus(listener: (status: SyncStatusInfo) => void): () => void {
			if (state.syncStatusBridge) {
				return state.syncStatusBridge.subscribe(listener)
			}
			listener(offlineSyncStatus())
			return () => {}
		},
		async connect(): Promise<void> {
			await ready
			if (state.syncEngine) {
				state.intentionalDisconnect = false
				state.reconnectionManager?.stop()
				state.reconnectionManager?.reset()
				await state.syncEngine.start()
				state.syncStatusBridge?.refresh()
			}
		},
		async disconnect(): Promise<void> {
			await ready
			if (state.syncEngine) {
				state.intentionalDisconnect = true
				state.reconnectionManager?.stop()
				await state.syncEngine.stop()
				state.syncStatusBridge?.refresh()
			}
		},
		getStatus(): SyncStatusInfo {
			if (state.syncEngine) {
				return state.syncEngine.getStatus()
			}
			return offlineSyncStatus()
		},
		async retryNow(): Promise<void> {
			await ready
			if (state.syncEngine) {
				await state.syncEngine.retryNow()
			}
		},
		clearSchemaBlock(): void {
			state.syncEngine?.clearSchemaBlock()
		},
		exportDiagnostics() {
			if (state.syncEngine) {
				return state.syncEngine.exportDiagnostics()
			}
			return {
				state: 'disconnected' as const,
				status: {
					status: 'offline' as const,
					pendingOperations: 0,
					lastSyncedAt: null,
					lastSuccessfulPush: null,
					lastSuccessfulPull: null,
					conflicts: 0,
				},
				nodeId: '',
				url: config.sync?.url ?? '',
				schemaVersion: config.schema.version,
				lastSyncedAt: null,
				lastSuccessfulPush: null,
				lastSuccessfulPull: null,
				conflicts: 0,
				pendingOperations: 0,
				hasInFlightBatch: false,
				reconnecting: false,
				timestamp: Date.now(),
			}
		},
	}
}

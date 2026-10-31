import type { SyncDiagnostics } from '@korajs/sync'
import type { KoraConfig } from './types'

/**
 * The diagnostics of an app whose sync engine does not exist (yet): disconnected, nothing
 * pending. Shared by the shell (before the runtime loads) and `app.sync`.
 */
export function offlineSyncDiagnostics(config: KoraConfig): SyncDiagnostics {
	return {
		state: 'disconnected' as const,
		status: {
			status: 'offline' as const,
			phase: 'offline' as const,
			reconnecting: false,
			pendingOperations: 0,
			lastSyncedAt: null,
			lastSuccessfulPush: null,
			lastSuccessfulPull: null,
			conflicts: 0,
			clockSkewMs: null,
			inFlightUploadOperations: 0,
			hasInFlightDeliveryBatch: false,
			activeViewId: '',
			activeViewComplete: false,
			initialSync: { complete: false, receivedBatches: 0, totalBatches: null, progress: null },
			deliveryWatermark: 0,
			serverFrontier: null,
			blockedFailure: null,
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
		deliveryWatermark: 0,
		deliveryGapRepeatCount: 0,
		timestamp: Date.now(),
	}
}

import type { RejectedOperation, SyncStatusInfo } from '@korajs/sync'
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

	const bridgeStatus = (): SyncStatusInfo => state.syncStatusBridge?.status ?? offlineSyncStatus()

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
		async reconnect(): Promise<void> {
			await ready
			if (state.syncEngine) {
				state.intentionalDisconnect = false
				state.reconnectionManager?.stop()
				state.reconnectionManager?.reset()
				await state.syncEngine.reconnect()
				state.syncStatusBridge?.refresh()
			}
		},
		async setQuerySubsets(subsets): Promise<void> {
			await ready
			state.syncEngine?.setQuerySubsets(subsets)
		},
		async waitForSettled(options = {}) {
			await ready
			const upload = options.upload ?? true
			const download = options.download ?? 'active-view'
			const classify = (): import('@korajs/sync').SyncSettlementResult | null => {
				const status = state.syncEngine?.getStatus() ?? offlineSyncStatus()
				if (status.phase === 'suspended')
					return { outcome: 'suspended', reason: status.reason ?? 'suspended', status }
				if (status.blockedFailure)
					return { outcome: 'blocked', failure: status.blockedFailure, status }
				if (status.phase === 'offline') return { outcome: 'offline', status }
				const uploadDone =
					!upload ||
					(status.pendingOperations === 0 && (status.inFlightUploadOperations ?? 0) === 0)
				const downloadDone = download === false || status.activeViewComplete
				return uploadDone && downloadDone ? { outcome: 'settled', status } : null
			}
			return await new Promise((resolve) => {
				let done = false
				let unsubscribeReady = false
				let cleanupPending = false
				let timer: ReturnType<typeof setTimeout> | null = null
				let unsubscribe = (): void => {}
				const finish = (result: import('@korajs/sync').SyncSettlementResult): void => {
					if (done) return
					done = true
					if (unsubscribeReady) unsubscribe()
					else cleanupPending = true
					if (timer) clearTimeout(timer)
					options.signal?.removeEventListener('abort', onAbort)
					resolve(result)
				}
				const check = (): void => {
					const result = classify()
					if (result) finish(result)
				}
				const onAbort = (): void =>
					finish({
						outcome: 'aborted',
						status: state.syncEngine?.getStatus() ?? offlineSyncStatus(),
					})
				// Subscribe before checking to avoid missing the settlement edge.
				unsubscribe = state.syncStatusBridge?.subscribe(check) ?? (() => {})
				unsubscribeReady = true
				if (cleanupPending) unsubscribe()
				options.signal?.addEventListener('abort', onAbort, { once: true })
				if (options.timeoutMs !== undefined)
					timer = setTimeout(
						() =>
							finish({
								outcome: 'timeout',
								status: state.syncEngine?.getStatus() ?? offlineSyncStatus(),
							}),
						options.timeoutMs,
					)
				if (options.signal?.aborted) onAbort()
				else check()
			})
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
		async getRejectedOperations(): Promise<RejectedOperation[]> {
			await ready
			if (state.syncEngine) {
				return state.syncEngine.getRejectedOperations()
			}
			return []
		},
		async clearRejectedOperations(operationIds: string[]): Promise<void> {
			await ready
			if (state.syncEngine) {
				await state.syncEngine.clearRejectedOperations(operationIds)
			}
		},
		exportDiagnostics() {
			if (state.syncEngine) {
				return state.syncEngine.exportDiagnostics()
			}
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
				clockSkewMs: null,
				pendingOperations: 0,
				hasInFlightBatch: false,
				reconnecting: false,
				deliveryWatermark: 0,
				deliveryGapRepeatCount: 0,
				timestamp: Date.now(),
			}
		},
	}
}

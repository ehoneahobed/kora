import type { KoraEventEmitter } from '@korajs/core'
import { ConnectionMonitor, ReconnectionManager, type SyncEngine } from '@korajs/sync'
import { AuthSyncCoordinator } from './auth-sync-coordinator'
import type { InitializeAppResult } from './initialize-app'
import { type SyncStatusBridge, createSyncStatusBridge } from './sync-status-bridge'
import type { KoraConfig } from './types'

/** Mutable sync runtime state owned by {@link createApp}. */
export interface SyncRuntimeState {
	syncEngine: SyncEngine | null
	syncStatusBridge: SyncStatusBridge | null
	authSyncCoordinator: AuthSyncCoordinator | null
	reconnectionManager: ReconnectionManager | null
	connectionMonitor: ConnectionMonitor | null
	qualityInterval: ReturnType<typeof setInterval> | null
	intentionalDisconnect: boolean
	/** Removes the browser `online` listener registered in {@link wireSyncLifecycleAfterReady}. */
	removeOnlineListener: (() => void) | null
}

/**
 * Wires sync status bridge, auth reconnect coordinator, reconnection, and quality monitoring
 * after {@link initializeApp} completes.
 */
export function wireSyncLifecycleAfterReady(
	config: KoraConfig,
	emitter: KoraEventEmitter,
	state: SyncRuntimeState,
	init: InitializeAppResult,
): void {
	state.syncEngine = init.syncEngine

	if (!config.sync) {
		return
	}

	state.syncStatusBridge = createSyncStatusBridge(emitter, () => state.syncEngine)
	state.syncStatusBridge.refresh()

	if (state.syncEngine && init.authBinding?.subscribe) {
		state.authSyncCoordinator = new AuthSyncCoordinator(() => state.syncEngine, init.authBinding)
		init.authBinding.subscribe(() => {
			state.authSyncCoordinator?.scheduleReconnect()
		})
	}

	if (!state.syncEngine) {
		return
	}

	const syncEngine = state.syncEngine
	state.connectionMonitor = new ConnectionMonitor()
	state.reconnectionManager = new ReconnectionManager({
		initialDelay: config.sync.reconnectInterval,
		maxDelay: config.sync.maxReconnectInterval,
	})

	// Feed measured clock skew into the store's HLC so remote-timestamp
	// validation uses server-corrected time even on devices with wrong clocks.
	emitter.on('sync:clock-skew', (event) => {
		init.store.setClockReferenceOffset(event.skewMs)
	})

	emitter.on('sync:sent', () => state.connectionMonitor?.recordActivity())
	emitter.on('sync:received', () => state.connectionMonitor?.recordActivity())
	emitter.on('sync:acknowledged', () => state.connectionMonitor?.recordActivity())

	emitter.on('sync:connected', () => {
		if (state.qualityInterval !== null) {
			clearInterval(state.qualityInterval)
		}
		state.qualityInterval = setInterval(() => {
			if (state.connectionMonitor) {
				emitter.emit({
					type: 'connection:quality',
					quality: state.connectionMonitor.getQuality(),
				})
			}
		}, 5000)
	})

	emitter.on('sync:disconnected', () => {
		state.connectionMonitor?.reset()
		if (state.qualityInterval !== null) {
			clearInterval(state.qualityInterval)
			state.qualityInterval = null
		}
	})

	const browserGlobal = globalThis as typeof globalThis & {
		addEventListener?: (type: string, listener: () => void) => void
		removeEventListener?: (type: string, listener: () => void) => void
	}
	if (typeof browserGlobal.addEventListener === 'function') {
		const onOnline = (): void => {
			if (state.intentionalDisconnect || config.sync?.autoReconnect === false) {
				return
			}
			state.reconnectionManager?.wake()
			state.reconnectionManager?.reset()
			void syncEngine.retryNow()
		}
		browserGlobal.addEventListener('online', onOnline)
		state.removeOnlineListener = (): void => {
			browserGlobal.removeEventListener?.('online', onOnline)
		}
	}

	emitter.on('sync:schema-mismatch', () => {
		state.reconnectionManager?.stop()
		state.intentionalDisconnect = true
	})

	if (config.sync.autoReconnect !== false) {
		emitter.on('sync:disconnected', () => {
			if (state.intentionalDisconnect || syncEngine.isSchemaBlocked()) {
				return
			}
			if (state.reconnectionManager?.isRunning()) {
				return
			}

			syncEngine.setReconnecting(true)
			state.reconnectionManager?.stop()
			state.reconnectionManager
				?.start(async () => {
					try {
						await syncEngine.start()
						syncEngine.setReconnecting(false)
						return true
					} catch {
						return false
					}
				})
				.then(() => {
					syncEngine.setReconnecting(false)
				})
		})
	}

	if (config.sync.autoConnect === true) {
		void syncEngine.start().catch(() => {
			// Errors surface via sync:disconnected / sync events; avoid unhandled rejection.
		})
	}
}

/**
 * Stops timers and managers during {@link KoraApp.close}.
 */
export function teardownSyncLifecycle(state: SyncRuntimeState): void {
	if (state.qualityInterval !== null) {
		clearInterval(state.qualityInterval)
		state.qualityInterval = null
	}
	state.reconnectionManager?.stop()
	state.syncStatusBridge?.destroy()
	state.syncStatusBridge = null
	state.authSyncCoordinator?.destroy()
	state.authSyncCoordinator = null
	state.removeOnlineListener?.()
	state.removeOnlineListener = null
}

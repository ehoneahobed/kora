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
	// The backoff resets only after a session has stayed up (streaming) for a while,
	// and a session that drops sooner keeps backing off (SYNC-8).
	syncEngine.onStateChange((engineState) => {
		if (engineState === 'streaming') state.reconnectionManager?.reportConnected()
		else if (engineState === 'disconnected') state.reconnectionManager?.reportDisconnected()
	})
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
			// A disconnect while an attempt is in flight makes that attempt count as failed,
			// so the running loop retries instead of exiting (NEW-SYNC-2).
			if (state.reconnectionManager?.requestRetry()) {
				return
			}

			syncEngine.setReconnecting(true)
			state.reconnectionManager
				?.start(async () => {
					try {
						await syncEngine.start()
					} catch {
						return false
					}
					// Success means the session reached streaming, not that the handshake was
					// sent: a server that accepts and then drops sessions must not reset the
					// backoff (SYNC-8).
					const streaming = await waitForStreaming(syncEngine)
					if (streaming) syncEngine.setReconnecting(false)
					return streaming
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
 * Resolve true once the engine reaches `streaming`, false as soon as it falls back to
 * `disconnected` or `error` first. A slow initial sync (minutes on 2G) is not a
 * failure: it resolves when that sync completes or the connection drops.
 */
function waitForStreaming(syncEngine: SyncEngine): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const current = syncEngine.getState()
		if (current === 'streaming') {
			resolve(true)
			return
		}
		if (current === 'disconnected' || current === 'error') {
			resolve(false)
			return
		}
		const unsubscribe = syncEngine.onStateChange((next) => {
			if (next === 'streaming' || next === 'disconnected' || next === 'error') {
				unsubscribe()
				resolve(next === 'streaming')
			}
		})
	})
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

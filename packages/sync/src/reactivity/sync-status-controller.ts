import type { KoraEventEmitter, KoraEventType } from '@korajs/core'
import type { SyncStatusInfo } from '../types'

/** Default status when sync is not configured or the engine is unavailable. */
export const OFFLINE_SYNC_STATUS: SyncStatusInfo = Object.freeze({
	status: 'offline',
	pendingOperations: 0,
	lastSyncedAt: null,
	lastSuccessfulPush: null,
	lastSuccessfulPull: null,
	conflicts: 0,
	clockSkewMs: null,
})

const SYNC_STATUS_EVENT_TYPES = [
	'sync:connected',
	'sync:clock-skew',
	'sync:disconnected',
	'sync:schema-mismatch',
	'sync:auth-failed',
	'sync:sent',
	'sync:received',
	'sync:acknowledged',
	'sync:apply-failed',
	'sync:diagnostics',
	'sync:initial-sync-progress',
] as const satisfies readonly KoraEventType[]

export interface SyncStatusControllerOptions {
	syncEngine?: { getStatus(): SyncStatusInfo } | null
	getSyncEngine?: () => { getStatus(): SyncStatusInfo } | null
	subscribeSyncStatus: ((listener: (status: SyncStatusInfo) => void) => () => void) | null
	events: KoraEventEmitter | null
}

export interface SyncStatusController {
	getSnapshot(): SyncStatusInfo
	subscribe(listener: () => void): () => void
	refresh(): void
	destroy(): void
}

/**
 * Framework-agnostic sync status subscription with live reads when no bridge exists.
 */
export function createSyncStatusController(
	options: SyncStatusControllerOptions,
): SyncStatusController {
	const useLiveSnapshot = options.subscribeSyncStatus === null && options.events === null
	let snapshot = OFFLINE_SYNC_STATUS
	let serialized = JSON.stringify(OFFLINE_SYNC_STATUS)
	const listeners = new Set<() => void>()
	let cleanup: (() => void) | null = null

	const resolveEngine = (): { getStatus(): SyncStatusInfo } | null => {
		return options.getSyncEngine?.() ?? options.syncEngine ?? null
	}

	const notify = (): void => {
		for (const listener of listeners) {
			listener()
		}
	}

	const setSnapshot = (next: SyncStatusInfo): void => {
		const nextSerialized = JSON.stringify(next)
		if (nextSerialized === serialized) {
			return
		}
		serialized = nextSerialized
		snapshot = next
		notify()
	}

	const refresh = (): void => {
		const engine = resolveEngine()
		const next = engine ? engine.getStatus() : OFFLINE_SYNC_STATUS
		setSnapshot(next)
	}

	const attach = (): void => {
		cleanup?.()

		if (options.subscribeSyncStatus) {
			cleanup = options.subscribeSyncStatus(setSnapshot)
			return
		}

		if (!resolveEngine()) {
			setSnapshot(OFFLINE_SYNC_STATUS)
			cleanup = () => {}
			return
		}

		if (options.events) {
			const unsubs = SYNC_STATUS_EVENT_TYPES.map((type) => options.events?.on(type, refresh))
			refresh()
			cleanup = () => {
				for (const unsub of unsubs) {
					unsub?.()
				}
			}
			return
		}

		refresh()
		cleanup = () => {}
	}

	attach()

	return {
		getSnapshot(): SyncStatusInfo {
			if (useLiveSnapshot) {
				const engine = resolveEngine()
				return engine ? engine.getStatus() : OFFLINE_SYNC_STATUS
			}
			return snapshot
		},
		subscribe(listener: () => void): () => void {
			listeners.add(listener)
			listener()
			return () => {
				listeners.delete(listener)
			}
		},
		refresh,
		destroy(): void {
			cleanup?.()
			cleanup = null
			listeners.clear()
		},
	}
}

import type { KoraEventEmitter, KoraEventType } from '@korajs/core'
import type { HeldNodeInfo, SyncStatusInfo } from '../types'

const NO_HELD_NODES: HeldNodeInfo[] = Object.freeze([]) as unknown as HeldNodeInfo[]

/** Default status when sync is not configured or the engine is unavailable. */
export const OFFLINE_SYNC_STATUS: SyncStatusInfo = Object.freeze({
	status: 'offline',
	phase: 'offline',
	reconnecting: false,
	pendingOperations: 0,
	lastSyncedAt: null,
	lastSuccessfulPush: null,
	lastSuccessfulPull: null,
	conflicts: 0,
	heldOperations: 0,
	heldNodes: NO_HELD_NODES,
	localDurability: 'durable',
	serverProtocolVersion: null,
	protocolDeprecated: false,
	clockSkewMs: null,
	inFlightUploadOperations: 0,
	hasInFlightDeliveryBatch: false,
	activeViewId: '',
	activeViewComplete: false,
	initialSync: { complete: false, receivedBatches: 0, totalBatches: null, progress: null },
	deliveryWatermark: 0,
	serverFrontier: null,
	blockedFailure: null,
})

/**
 * Returns `next` with every value unchanged since `previous` carried over by
 * reference, and the optional Phase 2/3 fields defaulted, so UI bindings see the
 * same object (and the same nested `heldNodes`, `initialSync`, `blockedFailure`)
 * until something actually changes (DX-5). Returns `previous` itself when nothing did.
 */
export function stabilizeSyncStatus(
	next: SyncStatusInfo,
	previous: SyncStatusInfo | null,
): SyncStatusInfo {
	const normalized: SyncStatusInfo = {
		...next,
		heldOperations: next.heldOperations ?? 0,
		heldNodes: next.heldNodes && next.heldNodes.length > 0 ? next.heldNodes : NO_HELD_NODES,
		localDurability: next.localDurability ?? 'durable',
		serverProtocolVersion: next.serverProtocolVersion ?? null,
		protocolDeprecated: next.protocolDeprecated ?? false,
	}
	if (previous === null) return Object.freeze(normalized)

	const nextRecord = normalized as unknown as Record<string, unknown>
	const prevRecord = previous as unknown as Record<string, unknown>
	let changed = Object.keys(prevRecord).some((key) => !(key in nextRecord))
	const merged: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(nextRecord)) {
		const before = prevRecord[key]
		if (key in prevRecord && (value === before || sameJson(value, before))) {
			merged[key] = before
		} else {
			merged[key] = value
			changed = true
		}
	}
	return changed ? (Object.freeze(merged) as unknown as SyncStatusInfo) : previous
}

function sameJson(a: unknown, b: unknown): boolean {
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
		return false
	}
	return JSON.stringify(a) === JSON.stringify(b)
}

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
	'sync:suspended',
	'sync:apply-blocked',
	'sync:apply-retrying',
	'sync:apply-recovered',
	'sync:delivery-gap',
	'sync:diagnostics',
	'sync:initial-sync-progress',
	'sync:durability-degraded',
	'sync:durability-restored',
	'sync:local-node',
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
		const stable = stabilizeSyncStatus(next, snapshot)
		if (stable === snapshot) {
			return
		}
		snapshot = stable
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
				// The engine builds a new object per call: keep the previous one while equal,
				// or useSyncExternalStore would see a change on every read and loop.
				const engine = resolveEngine()
				snapshot = stabilizeSyncStatus(engine ? engine.getStatus() : OFFLINE_SYNC_STATUS, snapshot)
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

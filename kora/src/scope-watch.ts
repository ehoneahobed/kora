import type { SyncStatusInfo } from '@korajs/sync'

/**
 * Whether the device now holds what its sync scope covers, judged from one sync status: the
 * session is caught up, or delivery has begun and no batch is in flight. Unlike the first-data
 * signal, an attempt that ended offline or a sync that is stopped does NOT count: nothing
 * arrived, so a query is not complete.
 *
 * @param status - One sync status
 * @returns True when the local store holds the whole scope
 */
export function scopeHeld(status: SyncStatusInfo): boolean {
	if (status.hasInFlightDeliveryBatch === true) return false
	if (status.phase === 'streaming') return true
	return (status.initialSync?.receivedBatches ?? 0) > 0
}

/**
 * Calls `onHeld` once, when the sync status first says the scope is held. Loaded after the
 * store opens, so the status check is not part of the first paint's JavaScript.
 *
 * @param sync - The app's sync engine, if it syncs
 * @param onHeld - Called once when the scope is held
 */
export function watchScopeHeld(
	sync: { subscribeStatus(listener: (status: SyncStatusInfo) => void): () => void } | null,
	onHeld: () => void,
): void {
	if (sync === null) return
	let held = false
	// The listener can run before subscribeStatus returns, so the unsubscribe function is read
	// through a holder rather than a binding that is not initialised yet.
	const subscription: { stop?: () => void } = {}
	subscription.stop = sync.subscribeStatus((status) => {
		if (held || !scopeHeld(status)) return
		held = true
		onHeld()
		subscription.stop?.()
	})
	if (held) subscription.stop()
}

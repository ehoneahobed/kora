import type { KoraEventEmitter } from '@korajs/core'
import type { KoraSyncEvent } from './types'

const SYNC_EVENT_TYPES = [
	'sync:connected',
	'sync:disconnected',
	'sync:schema-mismatch',
	'sync:auth-failed',
	'sync:sent',
	'sync:received',
	'sync:acknowledged',
	'sync:apply-failed',
	'sync:diagnostics',
	'sync:bandwidth',
	'sync:initial-sync-progress',
] as const

/**
 * Forwards selected sync events from the app emitter to {@link KoraConfig.onSyncEvent}.
 */
export function wireSyncEventForwarding(
	emitter: KoraEventEmitter,
	handler: (event: KoraSyncEvent) => void,
): void {
	for (const type of SYNC_EVENT_TYPES) {
		emitter.on(type, (event) => {
			handler(event as KoraSyncEvent)
		})
	}
}

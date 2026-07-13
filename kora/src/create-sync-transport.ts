import { HttpLongPollingTransport, WebSocketTransport } from '@korajs/sync'
import type { SyncTransport } from '@korajs/sync'
import type { KoraConfig } from './types'

/**
 * Instantiates the sync transport matching {@link KoraConfig.sync} settings.
 */
export function createSyncTransport(sync: NonNullable<KoraConfig['sync']>): SyncTransport {
	if (sync.transport === 'http') {
		return new HttpLongPollingTransport()
	}
	return new WebSocketTransport()
}

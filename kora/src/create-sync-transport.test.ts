import { HttpLongPollingTransport, WebSocketTransport } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { createSyncTransport } from './create-sync-transport'

describe('createSyncTransport', () => {
	test('returns WebSocket transport by default', () => {
		const transport = createSyncTransport({ url: 'wss://example.com/kora' })
		expect(transport).toBeInstanceOf(WebSocketTransport)
	})

	test('returns HTTP long-polling transport when configured', () => {
		const transport = createSyncTransport({
			url: 'https://example.com/kora',
			transport: 'http',
		})
		expect(transport).toBeInstanceOf(HttpLongPollingTransport)
	})
})

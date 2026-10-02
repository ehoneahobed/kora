import { describe, expect, test } from 'vitest'
import type { SyncMessage } from './messages'
import { NegotiatedMessageSerializer } from './serializer'

/**
 * The per-device node token (RT-12) is what keeps an anonymous device's node id its
 * own; losing it on a wire format would lock the device out on reconnect.
 */
const formats = ['json', 'protobuf'] as const

describe('node token wire round-trip', () => {
	for (const format of formats) {
		test(`handshake nodeToken survives ${format}`, () => {
			const serializer = new NegotiatedMessageSerializer(format)
			const message: SyncMessage = {
				type: 'handshake',
				messageId: 'm1',
				nodeId: 'n1',
				versionVector: {},
				schemaVersion: 1,
				nodeToken: 'tok-abc_123',
			}
			const decoded = serializer.decode(serializer.encode(message))
			expect(decoded.type === 'handshake' && decoded.nodeToken).toBe('tok-abc_123')
		})

		test(`handshake-response nodeToken survives ${format}`, () => {
			const serializer = new NegotiatedMessageSerializer(format)
			const message: SyncMessage = {
				type: 'handshake-response',
				messageId: 'm2',
				nodeId: 'server',
				versionVector: {},
				schemaVersion: 1,
				accepted: true,
				nodeToken: 'issued-token',
			}
			const decoded = serializer.decode(serializer.encode(message))
			expect(decoded.type === 'handshake-response' && decoded.nodeToken).toBe('issued-token')
		})

		test(`a handshake without a node token decodes without one (${format})`, () => {
			const serializer = new NegotiatedMessageSerializer(format)
			const decoded = serializer.decode(
				serializer.encode({
					type: 'handshake',
					messageId: 'm3',
					nodeId: 'n1',
					versionVector: {},
					schemaVersion: 1,
				}),
			)
			expect(decoded.type === 'handshake' && decoded.nodeToken).toBeFalsy()
		})
	}
})

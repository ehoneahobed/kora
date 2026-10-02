import { describe, expect, test } from 'vitest'
import type { SyncMessage } from './messages'
import { NegotiatedMessageSerializer } from './serializer'

/**
 * `sequenceReservation` (RT-37 / RT-35) tells the server this client reserves sequence
 * numbers transactionally, so it may enforce (node, sequence) uniqueness against it.
 * Losing the flag on a wire format would make a server treat a current client as legacy.
 */
const formats = ['json', 'protobuf'] as const

describe('handshake sequenceReservation wire round-trip', () => {
	for (const format of formats) {
		test(`survives ${format}`, () => {
			const serializer = new NegotiatedMessageSerializer(format)
			const message: SyncMessage = {
				type: 'handshake',
				messageId: 'm1',
				nodeId: 'n1',
				versionVector: {},
				schemaVersion: 1,
				sequenceReservation: true,
			}
			const decoded = serializer.decode(serializer.encode(message))
			expect(decoded.type === 'handshake' && decoded.sequenceReservation).toBe(true)
		})

		test(`is absent when not sent (${format})`, () => {
			const serializer = new NegotiatedMessageSerializer(format)
			const decoded = serializer.decode(
				serializer.encode({
					type: 'handshake',
					messageId: 'm2',
					nodeId: 'n1',
					versionVector: {},
					schemaVersion: 1,
				}),
			)
			expect(decoded.type === 'handshake' && decoded.sequenceReservation).toBeFalsy()
		})
	}
})

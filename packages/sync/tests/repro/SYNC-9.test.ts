/**
 * SYNC-9 repro: protobuf wire format is not loss-free. A handshake round-tripped through
 * ProtobufMessageSerializer loses fields the protocol depends on (query subsets, delta
 * cursor, delivery watermark), and the server-advertised wire-format switch never reaches
 * the transports that actually frame messages. Asserts CORRECT behavior (lossless).
 */
import { describe, expect, test } from 'vitest'
import type { HandshakeMessage, HandshakeResponseMessage } from '../../src/protocol/messages'
import { ProtobufMessageSerializer } from '../../src/protocol/serializer'

describe('SYNC-9: protobuf serializer drops protocol fields', () => {
	test('handshake fields survive a protobuf round trip', () => {
		const s = new ProtobufMessageSerializer()
		const handshake: HandshakeMessage = {
			type: 'handshake',
			messageId: 'm1',
			nodeId: 'n1',
			versionVector: { n1: 3 },
			schemaVersion: 1,
			supportedWireFormats: ['json', 'protobuf'],
			syncQueries: [{ collection: 'todos', where: { completed: false } }],
			deltaCursor: 'cursor-abc',
			lastDeliverySequence: 42,
		}
		const back = s.decode(s.encode(handshake)) as HandshakeMessage
		expect({
			syncQueries: back.syncQueries,
			deltaCursor: back.deltaCursor,
			lastDeliverySequence: back.lastDeliverySequence,
		}).toEqual({
			syncQueries: handshake.syncQueries,
			deltaCursor: handshake.deltaCursor,
			lastDeliverySequence: 42,
		})
	})

	test('handshake-response schema range survives a protobuf round trip', () => {
		const s = new ProtobufMessageSerializer()
		const resp: HandshakeResponseMessage = {
			type: 'handshake-response',
			messageId: 'm2',
			nodeId: 'server',
			versionVector: {},
			schemaVersion: 2,
			accepted: false,
			rejectReason: 'schema mismatch',
			supportedSchemaMin: 1,
			supportedSchemaMax: 2,
		}
		const back = s.decode(s.encode(resp)) as HandshakeResponseMessage
		expect([back.supportedSchemaMin, back.supportedSchemaMax]).toEqual([1, 2])
	})
})

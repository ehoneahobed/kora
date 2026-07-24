import { describe, expect, test } from 'vitest'
import type { SyncMessage } from './messages'
import { NegotiatedMessageSerializer } from './serializer'

/**
 * The delivery-watermark protocol fields are optional and additive, but they carry
 * correctness-critical values, so they must survive every wire format the framework
 * negotiates. These tests round-trip them over both JSON and the static protobuf codec.
 */

const formats = ['json', 'protobuf'] as const

describe('delivery watermark wire round-trip', () => {
	for (const format of formats) {
		test(`handshake lastDeliverySequence survives ${format}`, () => {
			const serializer = new NegotiatedMessageSerializer(format)
			const message: SyncMessage = {
				type: 'handshake',
				messageId: 'm1',
				nodeId: 'n1',
				versionVector: { a: 3 },
				schemaVersion: 1,
				lastDeliverySequence: 4242,
			}
			const decoded = serializer.decode(serializer.encode(message))
			expect(decoded.type).toBe('handshake')
			if (decoded.type === 'handshake') {
				expect(decoded.lastDeliverySequence).toBe(4242)
			}
		})

		test(`operation-batch base/max delivery sequence survives ${format}`, () => {
			const serializer = new NegotiatedMessageSerializer(format)
			const message: SyncMessage = {
				type: 'operation-batch',
				messageId: 'm2',
				operations: [],
				isFinal: false,
				batchIndex: 0,
				baseDeliverySequence: 100,
				maxDeliverySequence: 150,
			}
			const decoded = serializer.decode(serializer.encode(message))
			expect(decoded.type).toBe('operation-batch')
			if (decoded.type === 'operation-batch') {
				expect(decoded.baseDeliverySequence).toBe(100)
				expect(decoded.maxDeliverySequence).toBe(150)
			}
		})

		test(`handshake-response serverMaxDeliverySequence survives ${format}`, () => {
			const serializer = new NegotiatedMessageSerializer(format)
			const message: SyncMessage = {
				type: 'handshake-response',
				messageId: 'm5',
				nodeId: 'server',
				versionVector: { a: 2 },
				schemaVersion: 1,
				accepted: true,
				serverMaxDeliverySequence: 987,
			}
			const decoded = serializer.decode(serializer.encode(message))
			expect(decoded.type).toBe('handshake-response')
			if (decoded.type === 'handshake-response') {
				expect(decoded.serverMaxDeliverySequence).toBe(987)
			}
		})

		test(`acknowledgment deliverySequence survives ${format}`, () => {
			const serializer = new NegotiatedMessageSerializer(format)
			const message: SyncMessage = {
				type: 'acknowledgment',
				messageId: 'm3',
				acknowledgedMessageId: 'm2',
				lastSequenceNumber: 7,
				deliverySequence: 150,
			}
			const decoded = serializer.decode(serializer.encode(message))
			expect(decoded.type).toBe('acknowledgment')
			if (decoded.type === 'acknowledgment') {
				expect(decoded.deliverySequence).toBe(150)
			}
		})

		test(`omitted delivery fields stay omitted over ${format}`, () => {
			const serializer = new NegotiatedMessageSerializer(format)
			const message: SyncMessage = {
				type: 'operation-batch',
				messageId: 'm4',
				operations: [],
				isFinal: true,
				batchIndex: 0,
			}
			const decoded = serializer.decode(serializer.encode(message))
			expect(decoded.type).toBe('operation-batch')
			if (decoded.type === 'operation-batch') {
				expect(decoded.baseDeliverySequence).toBeUndefined()
				expect(decoded.maxDeliverySequence).toBeUndefined()
			}
		})
	}
})

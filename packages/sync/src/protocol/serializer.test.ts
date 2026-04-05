import type { Operation, VersionVector } from '@korajs/core'
import { SyncError } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import type {
	AcknowledgmentMessage,
	ErrorMessage,
	HandshakeMessage,
	HandshakeResponseMessage,
	OperationBatchMessage,
	SerializedOperation,
} from './messages'
import {
	JsonMessageSerializer,
	NegotiatedMessageSerializer,
	ProtobufMessageSerializer,
	versionVectorToWire,
	wireToVersionVector,
} from './serializer'

function makeOperation(overrides?: Partial<Operation>): Operation {
	return {
		id: 'op-abc123',
		nodeId: 'node-1',
		type: 'insert',
		collection: 'todos',
		recordId: 'rec-1',
		data: { title: 'Test Todo', completed: false },
		previousData: null,
		timestamp: { wallTime: 1700000000000, logical: 0, nodeId: 'node-1' },
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...overrides,
	}
}

describe('versionVectorToWire', () => {
	test('converts empty Map to empty object', () => {
		const vector: VersionVector = new Map()
		expect(versionVectorToWire(vector)).toEqual({})
	})

	test('converts Map entries to object properties', () => {
		const vector: VersionVector = new Map([
			['node-1', 5],
			['node-2', 3],
		])
		expect(versionVectorToWire(vector)).toEqual({ 'node-1': 5, 'node-2': 3 })
	})
})

describe('ProtobufMessageSerializer', () => {
	const serializer = new ProtobufMessageSerializer()

	test('roundtrips handshake with supported formats', () => {
		const message: HandshakeMessage = {
			type: 'handshake',
			messageId: 'msg-1',
			nodeId: 'node-1',
			versionVector: { 'node-1': 2 },
			schemaVersion: 1,
			supportedWireFormats: ['json', 'protobuf'],
		}

		const encoded = serializer.encode(message)
		expect(encoded).toBeInstanceOf(Uint8Array)
		expect(serializer.decode(encoded)).toEqual(message)
	})

	test('roundtrips operation batch', () => {
		const operation = serializer.encodeOperation(makeOperation())
		const message: OperationBatchMessage = {
			type: 'operation-batch',
			messageId: 'msg-batch',
			operations: [operation],
			isFinal: true,
			batchIndex: 0,
		}

		const decoded = serializer.decode(serializer.encode(message))
		expect(decoded).toEqual(message)
	})

	test('roundtrips handshake response selected format', () => {
		const message: HandshakeResponseMessage = {
			type: 'handshake-response',
			messageId: 'resp-1',
			nodeId: 'server-1',
			versionVector: { 'node-1': 2 },
			schemaVersion: 1,
			accepted: true,
			selectedWireFormat: 'protobuf',
		}

		expect(serializer.decode(serializer.encode(message))).toEqual(message)
	})
})

describe('NegotiatedMessageSerializer', () => {
	test('switches encode mode after negotiation', () => {
		const serializer = new NegotiatedMessageSerializer('json')
		const message: AcknowledgmentMessage = {
			type: 'acknowledgment',
			messageId: 'ack-1',
			acknowledgedMessageId: 'msg-1',
			lastSequenceNumber: 4,
		}

		const jsonEncoded = serializer.encode(message)
		expect(typeof jsonEncoded).toBe('string')

		serializer.setWireFormat('protobuf')
		const protoEncoded = serializer.encode(message)
		expect(protoEncoded).toBeInstanceOf(Uint8Array)
		expect(serializer.decode(protoEncoded as Uint8Array)).toEqual(message)
	})
})

describe('wireToVersionVector', () => {
	test('converts empty object to empty Map', () => {
		const result = wireToVersionVector({})
		expect(result.size).toBe(0)
	})

	test('converts object properties to Map entries', () => {
		const result = wireToVersionVector({ 'node-1': 5, 'node-2': 3 })
		expect(result.get('node-1')).toBe(5)
		expect(result.get('node-2')).toBe(3)
	})

	test('roundtrips with versionVectorToWire', () => {
		const original: VersionVector = new Map([
			['node-a', 10],
			['node-b', 20],
			['node-c', 0],
		])
		const roundtripped = wireToVersionVector(versionVectorToWire(original))
		expect(roundtripped).toEqual(original)
	})
})

describe('JsonMessageSerializer', () => {
	const serializer = new JsonMessageSerializer()

	describe('encode/decode roundtrip', () => {
		test('roundtrips HandshakeMessage', () => {
			const msg: HandshakeMessage = {
				type: 'handshake',
				messageId: 'msg-1',
				nodeId: 'node-1',
				versionVector: { 'node-1': 5 },
				schemaVersion: 1,
			}
			const encoded = serializer.encode(msg)
			const decoded = serializer.decode(encoded)
			expect(decoded).toEqual(msg)
		})

		test('roundtrips HandshakeMessage with authToken', () => {
			const msg: HandshakeMessage = {
				type: 'handshake',
				messageId: 'msg-1',
				nodeId: 'node-1',
				versionVector: {},
				schemaVersion: 1,
				authToken: 'secret-token',
			}
			const decoded = serializer.decode(serializer.encode(msg))
			expect(decoded).toEqual(msg)
		})

		test('roundtrips HandshakeResponseMessage', () => {
			const msg: HandshakeResponseMessage = {
				type: 'handshake-response',
				messageId: 'msg-2',
				nodeId: 'server-1',
				versionVector: { 'node-1': 5, 'node-2': 3 },
				schemaVersion: 1,
				accepted: true,
			}
			const decoded = serializer.decode(serializer.encode(msg))
			expect(decoded).toEqual(msg)
		})

		test('roundtrips rejected HandshakeResponseMessage', () => {
			const msg: HandshakeResponseMessage = {
				type: 'handshake-response',
				messageId: 'msg-2',
				nodeId: 'server-1',
				versionVector: {},
				schemaVersion: 2,
				accepted: false,
				rejectReason: 'Schema version mismatch',
			}
			const decoded = serializer.decode(serializer.encode(msg))
			expect(decoded).toEqual(msg)
		})

		test('roundtrips OperationBatchMessage', () => {
			const op = serializer.encodeOperation(makeOperation())
			const msg: OperationBatchMessage = {
				type: 'operation-batch',
				messageId: 'msg-3',
				operations: [op],
				isFinal: true,
				batchIndex: 0,
			}
			const decoded = serializer.decode(serializer.encode(msg))
			expect(decoded).toEqual(msg)
		})

		test('roundtrips empty OperationBatchMessage', () => {
			const msg: OperationBatchMessage = {
				type: 'operation-batch',
				messageId: 'msg-3',
				operations: [],
				isFinal: true,
				batchIndex: 0,
			}
			const decoded = serializer.decode(serializer.encode(msg))
			expect(decoded).toEqual(msg)
		})

		test('roundtrips AcknowledgmentMessage', () => {
			const msg: AcknowledgmentMessage = {
				type: 'acknowledgment',
				messageId: 'msg-4',
				acknowledgedMessageId: 'msg-3',
				lastSequenceNumber: 10,
			}
			const decoded = serializer.decode(serializer.encode(msg))
			expect(decoded).toEqual(msg)
		})

		test('roundtrips ErrorMessage', () => {
			const msg: ErrorMessage = {
				type: 'error',
				messageId: 'msg-5',
				code: 'AUTH_FAILED',
				message: 'Invalid authentication token',
				retriable: false,
			}
			const decoded = serializer.decode(serializer.encode(msg))
			expect(decoded).toEqual(msg)
		})
	})

	describe('encodeOperation/decodeOperation', () => {
		test('roundtrips insert operation', () => {
			const op = makeOperation()
			const serialized = serializer.encodeOperation(op)
			const decoded = serializer.decodeOperation(serialized)
			expect(decoded).toEqual(op)
		})

		test('roundtrips update operation with previousData', () => {
			const op = makeOperation({
				type: 'update',
				data: { completed: true },
				previousData: { completed: false },
				sequenceNumber: 2,
				causalDeps: ['op-abc123'],
			})
			const serialized = serializer.encodeOperation(op)
			const decoded = serializer.decodeOperation(serialized)
			expect(decoded).toEqual(op)
		})

		test('roundtrips delete operation with null data', () => {
			const op = makeOperation({
				type: 'delete',
				data: null,
				previousData: null,
				sequenceNumber: 3,
			})
			const decoded = serializer.decodeOperation(serializer.encodeOperation(op))
			expect(decoded.data).toBeNull()
			expect(decoded.previousData).toBeNull()
		})

		test('preserves all timestamp fields', () => {
			const op = makeOperation({
				timestamp: { wallTime: 1700000000000, logical: 42, nodeId: 'special-node' },
			})
			const decoded = serializer.decodeOperation(serializer.encodeOperation(op))
			expect(decoded.timestamp).toEqual({
				wallTime: 1700000000000,
				logical: 42,
				nodeId: 'special-node',
			})
		})

		test('preserves causal dependencies', () => {
			const op = makeOperation({
				causalDeps: ['dep-1', 'dep-2', 'dep-3'],
			})
			const decoded = serializer.decodeOperation(serializer.encodeOperation(op))
			expect(decoded.causalDeps).toEqual(['dep-1', 'dep-2', 'dep-3'])
		})

		test('creates independent copy (no shared references)', () => {
			const op = makeOperation({ causalDeps: ['dep-1'] })
			const serialized = serializer.encodeOperation(op)
			const decoded = serializer.decodeOperation(serialized)

			// Mutating the serialized form should not affect the decoded
			serialized.causalDeps.push('dep-2')
			expect(decoded.causalDeps).toEqual(['dep-1'])
		})
	})

	describe('large batch', () => {
		test('roundtrips batch with 1000 operations', () => {
			const ops: SerializedOperation[] = []
			for (let i = 0; i < 1000; i++) {
				ops.push(
					serializer.encodeOperation(
						makeOperation({
							id: `op-${i}`,
							sequenceNumber: i + 1,
							recordId: `rec-${i}`,
						}),
					),
				)
			}
			const msg: OperationBatchMessage = {
				type: 'operation-batch',
				messageId: 'big-batch',
				operations: ops,
				isFinal: true,
				batchIndex: 0,
			}

			const decoded = serializer.decode(serializer.encode(msg))
			expect(decoded.type).toBe('operation-batch')
			const batch = decoded as OperationBatchMessage
			expect(batch.operations).toHaveLength(1000)
			expect(batch.operations[0]?.id).toBe('op-0')
			expect(batch.operations[999]?.id).toBe('op-999')
		})
	})

	describe('error handling', () => {
		test('throws SyncError for invalid JSON', () => {
			expect(() => serializer.decode('not valid json {')).toThrow(SyncError)
		})

		test('throws SyncError for valid JSON but invalid message', () => {
			expect(() => serializer.decode('{"foo": "bar"}')).toThrow(SyncError)
		})

		test('throws SyncError for primitive JSON', () => {
			expect(() => serializer.decode('"just a string"')).toThrow(SyncError)
		})

		test('throws SyncError for null JSON', () => {
			expect(() => serializer.decode('null')).toThrow(SyncError)
		})

		test('error includes context about received type', () => {
			try {
				serializer.decode('{"type": "unknown", "messageId": "x"}')
				expect.fail('should have thrown')
			} catch (err) {
				expect(err).toBeInstanceOf(SyncError)
				const syncErr = err as SyncError
				expect(syncErr.context?.receivedType).toBe('unknown')
			}
		})
	})
})

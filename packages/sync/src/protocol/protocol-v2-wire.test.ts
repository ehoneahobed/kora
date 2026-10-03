import type { EncryptedOperationEnvelope, Operation } from '@korajs/core'
import protobuf from 'protobufjs/minimal.js'
import { describe, expect, test } from 'vitest'
import type {
	HandshakeMessage,
	HandshakeResponseMessage,
	OperationBatchMessage,
	SerializedOperation,
} from './messages'
import { SYNC_PROTOCOL_VERSION, declaredProtocolVersion } from './protocol-version'
import {
	JsonMessageSerializer,
	type MessageSerializer,
	NegotiatedMessageSerializer,
	ProtobufMessageSerializer,
	normalizeEnvelope,
} from './serializer'

/**
 * Protocol v2 wire fields (D2): every new field survives JSON and protobuf, and an
 * older (protocol-1) decoder that ignores them still decodes the rest.
 *
 * Protobuf numbers: envelope 46 authoritativeNodeIds (repeated string), 47
 * protocolVersion (uint32); operation 14 hashVersion (uint32), 15 foldState (string),
 * 16 encrypted (JSON string).
 */
const serializers: [string, MessageSerializer][] = [
	['json', new JsonMessageSerializer()],
	['protobuf', new ProtobufMessageSerializer()],
]

const envelope: EncryptedOperationEnvelope = {
	v: 2,
	alg: 'aes-256-gcm',
	keyId: 'k-1a2b3c4d',
	keyVersion: 3,
	data: { iv: 'aXYxMjM0NTY3ODkw', ct: 'Y2lwaGVydGV4dA==' },
	previousData: null,
	atomicOps: { iv: 'aXYyMjM0NTY3ODkw', ct: 'YXRvbWlj' },
}

function op(overrides: Partial<Operation> = {}): Operation {
	return {
		id: 'a'.repeat(64),
		nodeId: 'node-a',
		type: 'update',
		collection: 'todos',
		recordId: 'rec-1',
		data: { title: 'x' },
		previousData: { title: 'w' },
		timestamp: { wallTime: 1000, logical: 2, nodeId: 'node-a' },
		sequenceNumber: 7,
		causalDeps: ['dep'],
		schemaVersion: 1,
		...overrides,
	}
}

function roundTrip(serializer: MessageSerializer, operation: Operation): Operation {
	const batch: OperationBatchMessage = {
		type: 'operation-batch',
		messageId: 'm-1',
		operations: [serializer.encodeOperation(operation)],
		isFinal: true,
		batchIndex: 0,
	}
	const decoded = serializer.decode(serializer.encode(batch)) as OperationBatchMessage
	return serializer.decodeOperation(decoded.operations[0] as SerializedOperation)
}

describe('protocol v2 operation fields', () => {
	test.each(serializers)('%s: hashVersion round-trips (1, 2, absent)', (_n, s) => {
		expect(roundTrip(s, op({ hashVersion: 2 })).hashVersion).toBe(2)
		expect(roundTrip(s, op({ hashVersion: 1 })).hashVersion).toBe(1)
		expect('hashVersion' in roundTrip(s, op())).toBe(false)
	})

	test.each(serializers)('%s: foldState round-trips and stays out of data', (_n, s) => {
		const back = roundTrip(s, op({ type: 'insert', previousData: null, foldState: '{"f":1}' }))
		expect(back.foldState).toBe('{"f":1}')
		expect(back.data).toEqual({ title: 'x' })
	})

	test.each(serializers)('%s: encryption envelope round-trips with data null', (_n, s) => {
		const encrypted = op({ data: null, previousData: null, hashVersion: 2, encrypted: envelope })
		const back = roundTrip(s, encrypted)
		expect(back.encrypted).toEqual(envelope)
		expect(back.data).toBeNull()
		expect(back.previousData).toBeNull()
		expect(back.hashVersion).toBe(2)
	})

	test.each(serializers)('%s: cleartext scope fields beside an envelope survive', (_n, s) => {
		const back = roundTrip(s, op({ data: { ownerId: 'u1' }, encrypted: envelope }))
		expect(back.data).toEqual({ ownerId: 'u1' })
		expect(back.encrypted).toEqual(envelope)
	})

	test.each(serializers)('%s: atomicOps survive on an operation without data', (_n, s) => {
		const back = roundTrip(
			s,
			op({ type: 'delete', data: null, atomicOps: { n: { type: 'increment', value: 2 } } }),
		)
		expect(back.atomicOps).toEqual({ n: { type: 'increment', value: 2 } })
		expect(back.data).toBeNull()
	})

	test.each(serializers)('%s: an unknown declared hashVersion is kept (fails closed)', (_n, s) => {
		const wire = { ...s.encodeOperation(op()), hashVersion: 9 as unknown as 2 }
		const batch: OperationBatchMessage = {
			type: 'operation-batch',
			messageId: 'm',
			operations: [wire],
			isFinal: true,
			batchIndex: 0,
		}
		const decoded = s.decode(s.encode(batch)) as OperationBatchMessage
		expect(s.decodeOperation(decoded.operations[0] as SerializedOperation).hashVersion).toBe(9)
	})

	test('json: a malformed envelope from a peer is dropped, not applied as garbage', () => {
		const s = new JsonMessageSerializer()
		const wire = { ...s.encodeOperation(op()), encrypted: { v: 2, alg: 'rot13' } }
		expect(s.decodeOperation(wire as unknown as SerializedOperation).encrypted).toBeUndefined()
		expect(normalizeEnvelope({ ...envelope, data: { iv: 1 } })).toBeUndefined()
		expect(normalizeEnvelope(envelope)).toEqual(envelope)
	})
})

describe('protocol v2 handshake fields', () => {
	const handshake: HandshakeMessage = {
		type: 'handshake',
		messageId: 'h',
		nodeId: 'node-a',
		versionVector: { 'node-a': 3 },
		schemaVersion: 1,
		sequenceReservation: true,
		protocolVersion: SYNC_PROTOCOL_VERSION,
	}
	const response: HandshakeResponseMessage = {
		type: 'handshake-response',
		messageId: 'r',
		nodeId: 'server',
		versionVector: {},
		schemaVersion: 1,
		accepted: true,
		protocolVersion: 2,
		authoritativeNodeIds: ['server', 'kora:scope-entry'],
	}

	test.each(serializers)('%s: handshake protocolVersion round-trips', (_n, s) => {
		const back = s.decode(s.encode(handshake)) as HandshakeMessage
		expect(back.protocolVersion).toBe(2)
		expect(back.sequenceReservation).toBe(true)
	})

	test.each(serializers)('%s: response carries protocolVersion and authoritative ids', (_n, s) => {
		const back = s.decode(s.encode(response)) as HandshakeResponseMessage
		expect(back.protocolVersion).toBe(2)
		expect(back.authoritativeNodeIds).toEqual(['server', 'kora:scope-entry'])
	})

	test.each(serializers)(
		'%s: response carries revoked authoritative ids (field 48, RT-81)',
		(_n, s) => {
			const revoking = { ...response, revokedAuthoritativeNodeIds: ['admin-svc', 'legacy-a'] }
			const back = s.decode(s.encode(revoking)) as HandshakeResponseMessage
			expect(back.revokedAuthoritativeNodeIds).toEqual(['admin-svc', 'legacy-a'])
			expect(
				(s.decode(s.encode(response)) as HandshakeResponseMessage).revokedAuthoritativeNodeIds,
			).toBeUndefined()
		},
	)

	test.each(serializers)('%s: a beta.13 message (no v2 fields) decodes as protocol 1', (_n, s) => {
		const { protocolVersion: _p, ...legacy } = handshake
		const back = s.decode(s.encode(legacy)) as HandshakeMessage
		expect(back.protocolVersion).toBeUndefined()
		expect(declaredProtocolVersion(back.protocolVersion)).toBe(1)
		const { protocolVersion: _q, authoritativeNodeIds: _a, ...oldResponse } = response
		const backResponse = s.decode(s.encode(oldResponse)) as HandshakeResponseMessage
		expect(backResponse.authoritativeNodeIds).toBeUndefined()
	})

	test('negotiated serializer decodes v2 protobuf frames', () => {
		const protobufSerializer = new ProtobufMessageSerializer()
		const negotiated = new NegotiatedMessageSerializer('json')
		const back = negotiated.decode(protobufSerializer.encode(response)) as HandshakeResponseMessage
		expect(back.authoritativeNodeIds).toEqual(['server', 'kora:scope-entry'])
	})
})

describe('protocol v2 protobuf fields are invisible to a protocol-1 decoder', () => {
	/**
	 * A beta.13 decoder skips unknown field numbers by wire type. Reproduce that by
	 * walking the bytes with the same rule: every v2 field (46, 47; operation 14-16)
	 * must be skippable, and the fields a v1 decoder knows must be unchanged.
	 */
	function fieldsOf(bytes: Uint8Array): number[] {
		const reader = protobuf.Reader.create(bytes)
		const fields: number[] = []
		while (reader.pos < reader.len) {
			const tag = reader.uint32()
			fields.push(tag >>> 3)
			reader.skipType(tag & 7)
		}
		return fields
	}

	test('envelope fields 46 and 47 are well-formed and skippable', () => {
		const s = new ProtobufMessageSerializer()
		const bytes = s.encode({
			type: 'handshake-response',
			messageId: 'r',
			nodeId: 'server',
			versionVector: {},
			schemaVersion: 1,
			accepted: true,
			protocolVersion: 2,
			authoritativeNodeIds: ['a', 'b'],
		})
		const fields = fieldsOf(bytes)
		expect(fields.filter((f) => f === 46)).toHaveLength(2)
		expect(fields).toContain(47)
	})

	test('operation fields 14-16 are well-formed and skippable', () => {
		const s = new ProtobufMessageSerializer()
		const bytes = s.encode({
			type: 'operation-batch',
			messageId: 'b',
			operations: [
				s.encodeOperation(op({ hashVersion: 2, foldState: 'f', data: null, encrypted: envelope })),
			],
			isFinal: true,
			batchIndex: 0,
		})
		const reader = protobuf.Reader.create(bytes)
		let opFields: number[] = []
		while (reader.pos < reader.len) {
			const tag = reader.uint32()
			if (tag >>> 3 === 11) {
				opFields = fieldsOf(reader.bytes())
			} else {
				reader.skipType(tag & 7)
			}
		}
		expect(opFields).toEqual(expect.arrayContaining([14, 15, 16]))
		expect(opFields.filter((f) => f > 16)).toEqual([])
	})
})

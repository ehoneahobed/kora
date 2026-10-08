/**
 * SYNC-9: the protobuf wire is lossless for EVERY sync message type, including the fields
 * added in Phases 2 and 3 (delivery watermark, directional scopes, query subsets, delta
 * cursor, schema range, heartbeat, sequence reservation, protocol v2, revocations,
 * encryption envelopes, per-field versions). A protobuf round trip must decode to exactly
 * what the JSON wire decodes to.
 */
import { fc, test } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import type { WrappedKeyRecord } from '../encryption/key-record'
import type { SerializedOperation, SyncMessage } from './messages'
import {
	JsonMessageSerializer,
	NegotiatedMessageSerializer,
	ProtobufMessageSerializer,
} from './serializer'

const json = new JsonMessageSerializer()
const proto = new ProtobufMessageSerializer()

function viaJson(message: SyncMessage): SyncMessage {
	return json.decode(json.encode(message))
}
function viaProto(message: SyncMessage): SyncMessage {
	return proto.decode(proto.encode(message))
}

const id = fc.string({ maxLength: 12 })
const seq = fc.oneof(fc.nat(), fc.integer({ min: 2 ** 40, max: Number.MAX_SAFE_INTEGER }))
const vector = fc.dictionary(id, fc.nat(), { maxKeys: 4 })
const jsonRecord = fc.dictionary(fc.string({ maxLength: 16 }), fc.jsonValue({ maxDepth: 2 }), {
	maxKeys: 5,
})
const scopeMap = fc.dictionary(id, jsonRecord, { maxKeys: 3 })
const hlc = fc.record({ wallTime: fc.nat(), logical: fc.nat({ max: 1000 }), nodeId: id })
const envelopeField = fc.record({ iv: fc.base64String(), ct: fc.base64String() })
const keyRecord: fc.Arbitrary<WrappedKeyRecord> = fc.record(
	{
		format: fc.constant(2 as const),
		keyring: id,
		ringId: id,
		revision: fc.integer({ min: 1, max: 1000 }),
		currentVersion: fc.integer({ min: 1, max: 10 }),
		kdf: fc.record({
			name: fc.constant('PBKDF2' as const),
			hash: fc.constant('SHA-256' as const),
			iterations: fc.integer({ min: 1, max: 1_000_000 }),
			salt: fc.base64String(),
		}),
		master: fc.record({ iv: fc.base64String(), wrappedKey: fc.base64String() }),
		keys: fc.array(
			fc.record({
				keyVersion: fc.integer({ min: 1, max: 10 }),
				keyId: id,
				iv: fc.base64String(),
				wrappedKey: fc.base64String(),
			}),
			{ minLength: 1, maxLength: 3 },
		),
		recovery: fc.record({
			alg: fc.constant('ECDH-P256+HKDF-SHA256+AES-GCM' as const),
			publicKey: fc.record({ x: id, y: id }),
			ephemeralPublicKey: fc.record({ x: id, y: id }),
			iv: fc.base64String(),
			wrappedKey: fc.base64String(),
		}),
		mac: fc.base64String(),
	},
	{
		requiredKeys: [
			'format',
			'keyring',
			'ringId',
			'revision',
			'currentVersion',
			'kdf',
			'master',
			'keys',
			'mac',
		],
	},
)

const operation: fc.Arbitrary<SerializedOperation> = fc.record(
	{
		id,
		nodeId: id,
		type: fc.constantFrom('insert' as const, 'update' as const, 'delete' as const),
		collection: id,
		recordId: id,
		data: fc.option(jsonRecord, { nil: null }),
		previousData: fc.option(jsonRecord, { nil: null }),
		timestamp: hlc,
		sequenceNumber: seq,
		causalDeps: fc.array(id, { maxLength: 3 }),
		schemaVersion: fc.nat({ max: 50 }),
		atomicOps: fc.dictionary(
			id,
			fc.record({ op: fc.constant('increment' as const), value: fc.integer() }),
			{ maxKeys: 2 },
		),
		transactionId: id,
		mutationName: id,
		fieldVersions: fc.dictionary(id, hlc, { maxKeys: 3 }),
		hashVersion: fc.constantFrom(1 as const, 2 as const),
		foldState: fc.string(),
		encrypted: fc.record({
			v: fc.constant(2 as const),
			alg: fc.constant('aes-256-gcm' as const),
			keyId: id,
			keyVersion: fc.nat(),
			data: fc.option(envelopeField, { nil: null }),
			previousData: fc.option(envelopeField, { nil: null }),
		}),
	},
	{
		requiredKeys: [
			'id',
			'nodeId',
			'type',
			'collection',
			'recordId',
			'data',
			'previousData',
			'timestamp',
			'sequenceNumber',
			'causalDeps',
			'schemaVersion',
		],
	},
) as fc.Arbitrary<SerializedOperation>

/** One arbitrary per message type; the Record type makes a missing type a compile error. */
const arbitraries: Record<SyncMessage['type'], fc.Arbitrary<SyncMessage>> = {
	handshake: fc.record(
		{
			type: fc.constant('handshake' as const),
			messageId: id,
			nodeId: id,
			versionVector: vector,
			schemaVersion: fc.nat({ max: 50 }),
			authToken: fc.string(),
			supportedWireFormats: fc.subarray(['json' as const, 'protobuf' as const]),
			syncScope: scopeMap,
			deltaCursor: fc.string(),
			syncQueries: fc.array(fc.record({ collection: id, where: jsonRecord }), { maxLength: 3 }),
			lastDeliverySequence: seq,
			acceptedScopeKey: fc.string(),
			acceptedScopeWatermark: seq,
			scopeExitPolicy: fc.constantFrom('retain' as const, 'retract' as const),
			nodeToken: fc.string(),
			supportsHeartbeat: fc.boolean(),
			sequenceReservation: fc.boolean(),
			protocolVersion: fc.nat({ max: 5 }),
		},
		{ requiredKeys: ['type', 'messageId', 'nodeId', 'versionVector', 'schemaVersion'] },
	),
	'handshake-response': fc.record(
		{
			type: fc.constant('handshake-response' as const),
			messageId: id,
			nodeId: id,
			versionVector: vector,
			schemaVersion: fc.nat({ max: 50 }),
			accepted: fc.boolean(),
			rejectReason: fc.string(),
			supportedSchemaMin: fc.nat({ max: 50 }),
			supportedSchemaMax: fc.nat({ max: 50 }),
			selectedWireFormat: fc.constantFrom('json' as const, 'protobuf' as const),
			acceptedScope: scopeMap,
			acceptedDownlinkScopes: scopeMap,
			acceptedUplinkScopes: scopeMap,
			serverTime: fc.nat(),
			blobStorageEnabled: fc.boolean(),
			serverMaxDeliverySequence: seq,
			nodeToken: fc.string(),
			blobPossessionProof: fc.boolean(),
			heartbeatIntervalMs: fc.nat(),
			protocolVersion: fc.nat({ max: 5 }),
			authoritativeNodeIds: fc.array(id, { maxLength: 3 }),
			revokedAuthoritativeNodeIds: fc.array(id, { maxLength: 3 }),
		},
		{
			requiredKeys: ['type', 'messageId', 'nodeId', 'versionVector', 'schemaVersion', 'accepted'],
		},
	),
	'operation-batch': fc.record(
		{
			type: fc.constant('operation-batch' as const),
			messageId: id,
			operations: fc.array(operation, { maxLength: 3 }),
			retractions: fc.array(fc.record({ collection: id, recordId: id }), { maxLength: 2 }),
			isFinal: fc.boolean(),
			batchIndex: fc.nat(),
			cursor: fc.string(),
			totalBatches: fc.nat(),
			baseDeliverySequence: seq,
			maxDeliverySequence: seq,
		},
		{ requiredKeys: ['type', 'messageId', 'operations', 'isFinal', 'batchIndex'] },
	),
	acknowledgment: fc.record(
		{
			type: fc.constant('acknowledgment' as const),
			messageId: id,
			acknowledgedMessageId: id,
			lastSequenceNumber: seq,
			deliverySequence: seq,
			nodeToken: fc.string(),
		},
		{ requiredKeys: ['type', 'messageId', 'acknowledgedMessageId', 'lastSequenceNumber'] },
	),
	error: fc.record(
		{
			type: fc.constant('error' as const),
			messageId: id,
			code: fc.string(),
			message: fc.string(),
			retriable: fc.boolean(),
			nodeOwnership: fc.constantFrom('other-principal' as const, 'unowned' as const),
		},
		{ requiredKeys: ['type', 'messageId', 'code', 'message', 'retriable'] },
	),
	'operation-rejected': fc.record({
		type: fc.constant('operation-rejected' as const),
		messageId: id,
		operationId: id,
		collection: id,
		recordId: id,
		code: fc.string(),
		message: fc.string(),
		retriable: fc.boolean(),
	}),
	'awareness-update': fc.record({
		type: fc.constant('awareness-update' as const),
		messageId: id,
		clientId: fc.nat(),
		states: fc.dictionary(
			fc.nat().map(String),
			fc.option(
				fc.record({
					user: fc.record({ name: fc.string(), color: fc.string() }),
					cursor: fc.record({
						collection: id,
						recordId: id,
						field: id,
						anchor: fc.nat(),
						head: fc.nat(),
					}),
				}),
				{ nil: null },
			),
			{ maxKeys: 3 },
		),
	}),
	'yjs-doc-update': fc.record({
		type: fc.constant('yjs-doc-update' as const),
		messageId: id,
		collection: id,
		recordId: id,
		field: id,
		update: fc.base64String(),
	}),
	'blob-chunk-request': fc.record({
		type: fc.constant('blob-chunk-request' as const),
		messageId: id,
		requestId: id,
		hash: id,
	}),
	'blob-chunk-response': fc.record(
		{
			type: fc.constant('blob-chunk-response' as const),
			messageId: id,
			requestId: id,
			bytes: fc.option(fc.base64String(), { nil: null }),
			throttled: fc.boolean(),
			retryAfterMs: fc.nat(),
		},
		{ requiredKeys: ['type', 'messageId', 'requestId', 'bytes'] },
	),
	'blob-chunk-push': fc.record({
		type: fc.constant('blob-chunk-push' as const),
		messageId: id,
		hash: id,
		bytes: fc.base64String(),
	}),
	heartbeat: fc.record({ type: fc.constant('heartbeat' as const), messageId: id }),
	// ENC-1 key distribution. NegotiatedMessageSerializer sends these as JSON on every
	// wire format, but a transport that uses the protobuf serializer explicitly must still
	// carry them losslessly (their bodies travel in the extension field).
	'encryption-key-request': fc.record({
		type: fc.constant('encryption-key-request' as const),
		messageId: id,
		requestId: id,
		keyring: id,
	}),
	'encryption-key-put': fc.record({
		type: fc.constant('encryption-key-put' as const),
		messageId: id,
		requestId: id,
		keyring: id,
		record: keyRecord,
		expectedRevision: fc.nat(),
	}),
	'encryption-key-response': fc.record(
		{
			type: fc.constant('encryption-key-response' as const),
			messageId: id,
			requestId: id,
			keyring: id,
			status: fc.constantFrom(
				'ok' as const,
				'conflict' as const,
				'forbidden' as const,
				'invalid' as const,
				'unsupported' as const,
				'throttled' as const,
			),
			record: fc.option(keyRecord, { nil: null }),
			message: fc.string(),
		},
		{ requiredKeys: ['type', 'messageId', 'keyring', 'status', 'record'] },
	),
}

describe('SYNC-9: protobuf round trip equals the JSON wire for every message type', () => {
	for (const [type, arbitrary] of Object.entries(arbitraries)) {
		test.prop([arbitrary], { numRuns: 200 })(`${type}`, (message) => {
			expect(viaProto(message)).toEqual(viaJson(message))
		})
	}

	test.prop([fc.constantFrom(...Object.values(arbitraries)).chain((a) => a)], { numRuns: 300 })(
		'decodes through the binary payload a transport delivers (ArrayBuffer)',
		(message) => {
			const bytes = proto.encode(message)
			const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
			expect(proto.decode(buffer as ArrayBuffer)).toEqual(viaJson(message))
		},
	)
})

describe('ENC-1 key messages on the protobuf wire', () => {
	test('a put without its record is refused, not decoded with an invented one', () => {
		// Encode a valid put, then strip the record from the extension: the decoder must
		// refuse the message rather than hand the engine a put with no record.
		const message: SyncMessage = {
			type: 'encryption-key-put',
			messageId: 'm',
			requestId: 'r',
			keyring: 'default',
			expectedRevision: 0,
			record: {
				format: 2,
				keyring: 'default',
				ringId: 'r',
				revision: 1,
				currentVersion: 1,
				kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 1, salt: 'AAAA' },
				master: { iv: 'AA', wrappedKey: 'AA' },
				keys: [{ keyVersion: 1, keyId: 'k', iv: 'AA', wrappedKey: 'AA' }],
				mac: 'AA',
			},
		}
		const bytes = proto.encode(message)
		const tampered = Buffer.from(bytes).toString('latin1').replace('"record":', '"rekord":')
		expect(() => proto.decode(new Uint8Array(Buffer.from(tampered, 'latin1')))).toThrow(
			/invalid message structure/,
		)
	})

	test('NegotiatedMessageSerializer still sends key messages as JSON text on protobuf', () => {
		const negotiated = new NegotiatedMessageSerializer('protobuf')
		const encoded = negotiated.encode({
			type: 'encryption-key-request',
			messageId: 'm',
			requestId: 'r',
			keyring: 'default',
		})
		expect(typeof encoded).toBe('string')
	})
})

describe('protobuf extension field (49)', () => {
	test('a message the native fields carry exactly needs no extension', () => {
		const message: SyncMessage = {
			type: 'acknowledgment',
			messageId: 'm',
			acknowledgedMessageId: 'a',
			lastSequenceNumber: 3,
		}
		const bytes = proto.encode(message)
		// No field-49 tag (49 << 3 | 2 = 394, varint 0x8a 0x03) anywhere in the payload.
		const hex = Buffer.from(bytes).toString('hex')
		expect(hex.includes('8a03')).toBe(false)
		expect(viaProto(message)).toEqual(message)
	})

	test('the extension may not change the message type', () => {
		const message: SyncMessage = { type: 'heartbeat', messageId: 'h' }
		expect(viaProto(message).type).toBe('heartbeat')
	})
})

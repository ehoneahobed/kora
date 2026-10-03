import { SyncError } from '@korajs/core'
import type {
	EncryptedOperationEnvelope,
	HLCTimestamp,
	Operation,
	VersionVector,
} from '@korajs/core'
// protobufjs/minimal is CJS — named ESM imports fail in some runtimes (tsx, Node ESM).
// Use a default import for the runtime values and type aliases for annotations.
// The explicit .js extension is required: protobufjs has no "exports" map, so
// Node ESM cannot resolve the extensionless "protobufjs/minimal" subpath
// (bundlers tolerate it, which is why this only breaks in plain Node).
import protobuf from 'protobufjs/minimal.js'

type Reader = protobuf.Reader
type Writer = protobuf.Writer
const { Reader, Writer } = protobuf
import { isEncryptionKeyMessageType } from '../encryption/key-messages'
import type {
	AcknowledgmentMessage,
	ErrorMessage,
	HandshakeMessage,
	HandshakeResponseMessage,
	OperationBatchMessage,
	SerializedOperation,
	SyncMessage,
	WireFormat,
} from './messages'
import { isSyncMessage } from './messages'

export type EncodedMessage = string | Uint8Array

/**
 * Interface for encoding/decoding sync protocol messages.
 */
export interface MessageSerializer {
	encode(message: SyncMessage): EncodedMessage
	decode(data: string | Uint8Array | ArrayBuffer): SyncMessage
	encodeOperation(op: Operation): SerializedOperation
	decodeOperation(serialized: SerializedOperation): Operation
	setWireFormat?(format: WireFormat): void
	getWireFormat?(): WireFormat
}

/**
 * Convert a VersionVector (Map) to a plain object for wire transmission.
 */
export function versionVectorToWire(vector: VersionVector): Record<string, number> {
	const wire: Record<string, number> = {}
	for (const [nodeId, seq] of vector) {
		wire[nodeId] = seq
	}
	return wire
}

/**
 * Convert a wire-format version vector (plain object) back to a VersionVector (Map).
 */
export function wireToVersionVector(wire: Record<string, number>): VersionVector {
	return new Map(Object.entries(wire))
}

const WIRE_BYTES_KEY = '__kora_bytes__'

function toBase64(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}
	return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
	const binary = atob(value)
	const bytes = new Uint8Array(binary.length)
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index)
	}
	return bytes
}

function serializeWireRecord(
	record: Record<string, unknown> | null,
): Record<string, unknown> | null {
	if (!record) {
		return null
	}

	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(record)) {
		out[key] = serializeWireValue(value)
	}
	return out
}

function serializeWireValue(value: unknown): unknown {
	if (value instanceof Uint8Array) {
		return { [WIRE_BYTES_KEY]: toBase64(value) }
	}
	if (value instanceof ArrayBuffer) {
		return { [WIRE_BYTES_KEY]: toBase64(new Uint8Array(value)) }
	}
	return value
}

function deserializeWireRecord(
	record: Record<string, unknown> | null,
): Record<string, unknown> | null {
	if (!record) {
		return null
	}

	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(record)) {
		out[key] = deserializeWireValue(value)
	}
	return out
}

/**
 * A top-level op-data value in the wire's binary form: an object whose ONLY member is
 * `__kora_bytes__` (a base64 string), as `serializeWireValue` writes a `Uint8Array`
 * (beta.13 richtext). Any other object is data and is returned as is.
 *
 * Two earlier rules corrupted json and object values and are gone (value domain, RT-86):
 * an object that merely CONTAINED `__kora_bytes__` lost its other members, and an object
 * whose keys were all integers with number values (`{ "1": 2 }`, even `{ " ": 0 }`) was
 * read as the indexed byte record of the 0.5 internal beta and became a `Uint8Array`.
 * The local API refuses a field value that is exactly the binary form, so nothing a
 * device writes can be mistaken for it.
 */
function deserializeWireValue(value: unknown): unknown {
	if (isWireBytesValue(value)) {
		return fromBase64(value[WIRE_BYTES_KEY])
	}
	return value
}

function isWireBytesValue(value: unknown): value is Record<typeof WIRE_BYTES_KEY, string> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
	const keys = Object.keys(value)
	return (
		keys.length === 1 &&
		keys[0] === WIRE_BYTES_KEY &&
		typeof (value as Record<string, unknown>)[WIRE_BYTES_KEY] === 'string'
	)
}

/**
 * JSON-based message serializer.
 */
export class JsonMessageSerializer implements MessageSerializer {
	encode(message: SyncMessage): string {
		return JSON.stringify(message)
	}

	decode(data: string | Uint8Array | ArrayBuffer): SyncMessage {
		const text = decodeTextPayload(data)

		let parsed: unknown
		try {
			parsed = JSON.parse(text)
		} catch {
			throw new SyncError('Failed to decode sync message: invalid JSON', {
				dataLength: text.length,
			})
		}

		if (!isSyncMessage(parsed)) {
			throw new SyncError('Failed to decode sync message: invalid message structure', {
				receivedType:
					typeof parsed === 'object' && parsed !== null
						? (parsed as Record<string, unknown>).type
						: typeof parsed,
			})
		}

		return parsed
	}

	encodeOperation(op: Operation): SerializedOperation {
		return {
			id: op.id,
			nodeId: op.nodeId,
			type: op.type,
			collection: op.collection,
			recordId: op.recordId,
			data: serializeWireRecord(op.data),
			previousData: serializeWireRecord(op.previousData),
			timestamp: {
				wallTime: op.timestamp.wallTime,
				logical: op.timestamp.logical,
				nodeId: op.timestamp.nodeId,
			},
			sequenceNumber: op.sequenceNumber,
			causalDeps: [...op.causalDeps],
			schemaVersion: op.schemaVersion,
			...(op.atomicOps !== undefined ? { atomicOps: op.atomicOps } : {}),
			...(op.transactionId !== undefined ? { transactionId: op.transactionId } : {}),
			...(op.mutationName !== undefined ? { mutationName: op.mutationName } : {}),
			...(op.fieldVersions !== undefined
				? { fieldVersions: copyFieldVersions(op.fieldVersions) }
				: {}),
			...(op.hashVersion !== undefined ? { hashVersion: op.hashVersion } : {}),
			...(op.foldState !== undefined ? { foldState: op.foldState } : {}),
			...(op.encrypted !== undefined ? { encrypted: copyEnvelope(op.encrypted) } : {}),
		}
	}

	decodeOperation(serialized: SerializedOperation): Operation {
		return {
			id: serialized.id,
			nodeId: serialized.nodeId,
			type: serialized.type,
			collection: serialized.collection,
			recordId: serialized.recordId,
			data: deserializeWireRecord(serialized.data),
			previousData: deserializeWireRecord(serialized.previousData),
			timestamp: {
				wallTime: serialized.timestamp.wallTime,
				logical: serialized.timestamp.logical,
				nodeId: serialized.timestamp.nodeId,
			},
			sequenceNumber: serialized.sequenceNumber,
			causalDeps: [...serialized.causalDeps],
			schemaVersion: serialized.schemaVersion,
			...(serialized.atomicOps !== undefined ? { atomicOps: serialized.atomicOps } : {}),
			...(serialized.transactionId !== undefined
				? { transactionId: serialized.transactionId }
				: {}),
			...(serialized.mutationName !== undefined ? { mutationName: serialized.mutationName } : {}),
			...withFieldVersions(serialized.fieldVersions),
			...withHashVersion(serialized.hashVersion),
			...(typeof serialized.foldState === 'string' ? { foldState: serialized.foldState } : {}),
			...withEnvelope(serialized.encrypted),
		}
	}
}

/**
 * Carry a wire hash version through. 1 and 2 are the defined versions. Any other
 * declared value (an unknown future version, garbage from an untrusted peer) is kept,
 * so id verification fails closed instead of treating the operation as version 1.
 */
function withHashVersion(raw: unknown): { hashVersion?: 1 | 2 } {
	if (raw === undefined || raw === null) return {}
	return { hashVersion: raw as 1 | 2 }
}

/**
 * Validate a wire encryption envelope (protocol v2). A malformed envelope from an
 * untrusted peer is dropped; the operation then has no envelope and fails decryption
 * (encryption enabled: plaintext is refused) or id verification. It never applies
 * as garbage.
 *
 * @param raw - The decoded `encrypted` value
 * @returns A validated copy, or undefined
 */
export function normalizeEnvelope(raw: unknown): EncryptedOperationEnvelope | undefined {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
	const env = raw as Record<string, unknown>
	if (
		env.v !== 2 ||
		env.alg !== 'aes-256-gcm' ||
		typeof env.keyId !== 'string' ||
		typeof env.keyVersion !== 'number' ||
		!Number.isInteger(env.keyVersion)
	) {
		return undefined
	}
	const data = normalizeEnvelopeField(env.data)
	const previousData = normalizeEnvelopeField(env.previousData)
	if (data === undefined || previousData === undefined) return undefined
	const atomicOps = env.atomicOps === undefined ? null : normalizeEnvelopeField(env.atomicOps)
	if (atomicOps === undefined) return undefined
	return {
		v: 2,
		alg: 'aes-256-gcm',
		keyId: env.keyId,
		keyVersion: env.keyVersion,
		data,
		previousData,
		...(atomicOps !== null ? { atomicOps } : {}),
	}
}

function normalizeEnvelopeField(raw: unknown): { iv: string; ct: string } | null | undefined {
	if (raw === null) return null
	if (typeof raw !== 'object' || raw === undefined) return undefined
	const field = raw as Record<string, unknown>
	if (typeof field.iv !== 'string' || typeof field.ct !== 'string') return undefined
	return { iv: field.iv, ct: field.ct }
}

function copyEnvelope(envelope: EncryptedOperationEnvelope): EncryptedOperationEnvelope {
	return {
		v: envelope.v,
		alg: envelope.alg,
		keyId: envelope.keyId,
		keyVersion: envelope.keyVersion,
		data: envelope.data ? { ...envelope.data } : null,
		previousData: envelope.previousData ? { ...envelope.previousData } : null,
		...(envelope.atomicOps ? { atomicOps: { ...envelope.atomicOps } } : {}),
	}
}

function withEnvelope(raw: unknown): { encrypted?: EncryptedOperationEnvelope } {
	const encrypted = raw === undefined ? undefined : normalizeEnvelope(raw)
	return encrypted !== undefined ? { encrypted } : {}
}

/**
 * Validate wire per-field versions (RT-27): a map of field name to a well-formed HLC
 * timestamp. Anything else (from an untrusted peer) yields undefined: the operation
 * is then applied with its single timestamp, never with a malformed version.
 *
 * @param raw - The decoded `fieldVersions` value
 * @returns A fresh validated copy, or undefined
 */
export function normalizeFieldVersions(raw: unknown): Record<string, HLCTimestamp> | undefined {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
	const result: Record<string, HLCTimestamp> = {}
	for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
		if (value === null || typeof value !== 'object') return undefined
		const ts = value as Record<string, unknown>
		if (
			typeof ts.wallTime !== 'number' ||
			!Number.isFinite(ts.wallTime) ||
			typeof ts.logical !== 'number' ||
			!Number.isFinite(ts.logical) ||
			typeof ts.nodeId !== 'string'
		) {
			return undefined
		}
		result[field] = { wallTime: ts.wallTime, logical: ts.logical, nodeId: ts.nodeId }
	}
	return result
}

function copyFieldVersions(versions: Record<string, HLCTimestamp>): Record<string, HLCTimestamp> {
	const copy: Record<string, HLCTimestamp> = {}
	for (const [field, ts] of Object.entries(versions)) {
		copy[field] = { wallTime: ts.wallTime, logical: ts.logical, nodeId: ts.nodeId }
	}
	return copy
}

function withFieldVersions(raw: unknown): { fieldVersions?: Record<string, HLCTimestamp> } {
	const fieldVersions = raw === undefined ? undefined : normalizeFieldVersions(raw)
	return fieldVersions !== undefined ? { fieldVersions } : {}
}

/**
 * Protobuf-based serializer for sync messages.
 */
export class ProtobufMessageSerializer implements MessageSerializer {
	encode(message: SyncMessage): Uint8Array {
		const envelope = toProtoEnvelope(message)
		return encodeEnvelope(envelope)
	}

	decode(data: string | Uint8Array | ArrayBuffer): SyncMessage {
		const bytes = toBytes(data)
		const envelope = decodeEnvelope(bytes)
		return fromProtoEnvelope(envelope)
	}

	encodeOperation(op: Operation): SerializedOperation {
		return new JsonMessageSerializer().encodeOperation(op)
	}

	decodeOperation(serialized: SerializedOperation): Operation {
		return new JsonMessageSerializer().decodeOperation(serialized)
	}
}

/**
 * Negotiated serializer that supports runtime wire-format switching.
 */
export class NegotiatedMessageSerializer implements MessageSerializer {
	private readonly json = new JsonMessageSerializer()
	private readonly protobuf = new ProtobufMessageSerializer()
	private wireFormat: WireFormat

	constructor(initialWireFormat: WireFormat = 'json') {
		this.wireFormat = initialWireFormat
	}

	encode(message: SyncMessage): EncodedMessage {
		if (this.wireFormat === 'protobuf' && !isEncryptionKeyMessageType(message.type)) {
			return this.protobuf.encode(message)
		}

		return this.json.encode(message)
	}

	decode(data: string | Uint8Array | ArrayBuffer): SyncMessage {
		if (typeof data === 'string') {
			return this.json.decode(data)
		}

		try {
			return this.protobuf.decode(data)
		} catch {
			return this.json.decode(data)
		}
	}

	encodeOperation(op: Operation): SerializedOperation {
		return this.json.encodeOperation(op)
	}

	decodeOperation(serialized: SerializedOperation): Operation {
		return this.json.decodeOperation(serialized)
	}

	setWireFormat(format: WireFormat): void {
		this.wireFormat = format
	}

	getWireFormat(): WireFormat {
		return this.wireFormat
	}
}

interface ProtoVectorEntry {
	key: string
	value: number
}

interface ProtoTimestamp {
	wallTime: number
	logical: number
	nodeId: string
}

interface ProtoOperation {
	id: string
	nodeId: string
	type: string
	collection: string
	recordId: string
	dataJson: string
	previousDataJson: string
	timestamp: ProtoTimestamp
	sequenceNumber: number
	causalDeps: string[]
	schemaVersion: number
	hasData: boolean
	hasPreviousData: boolean
	/** Field 14: content-hash version (protocol v2). 0/absent = 1. */
	hashVersion?: number
	/** Field 15: serialized fold state of a server scope-entry operation. */
	foldState?: string
	/** Field 16: JSON of the encryption envelope v2. */
	encryptedJson?: string
}

interface ProtoEnvelope {
	type: SyncMessage['type']
	messageId: string
	nodeId?: string
	versionVector?: ProtoVectorEntry[]
	schemaVersion?: number
	authToken?: string
	supportedWireFormats?: string[]
	accepted?: boolean
	rejectReason?: string
	selectedWireFormat?: string
	serverTime?: number
	operations?: ProtoOperation[]
	isFinal?: boolean
	batchIndex?: number
	acknowledgedMessageId?: string
	lastSequenceNumber?: number
	errorCode?: string
	errorMessage?: string
	retriable?: boolean
	requestId?: string
	hash?: string
	/** Base64-encoded chunk bytes for a blob-chunk-response or blob-chunk-push. */
	chunkBytes?: string
	/** Distinguishes a held chunk (true) from "not held" (false) when bytes is empty/absent. */
	hasBytes?: boolean
	/** Whether the server persists blob bytes centrally (handshake-response). */
	blobStorageEnabled?: boolean
	/** Fields 26-28: per-operation rejection (operation-rejected). code/message/retriable reuse the error fields. */
	operationId?: string
	collection?: string
	recordId?: string
	/** Field 29: client's delivery watermark on a handshake. */
	lastDeliverySequence?: number
	/** Fields 30-31: delivery-stream chaining on an operation-batch. */
	baseDeliverySequence?: number
	maxDeliverySequence?: number
	/** Field 32: acked delivery sequence on an acknowledgment. */
	deliverySequence?: number
	/** Field 33: server's max delivery sequence on a handshake-response. */
	serverMaxDeliverySequence?: number
	/** Fields 34-37: directional scope/retraction protocol JSON and policy. */
	acceptedScopeJson?: string
	acceptedDownlinkScopesJson?: string
	acceptedUplinkScopesJson?: string
	retractionsJson?: string
	scopeExitPolicy?: string
	/** Field 39: per-device node token (handshake, handshake-response, RT-12; acknowledgment, RT-21). */
	nodeToken?: string
	/** Field 40: peer-relay server asks for blob possession proofs (handshake-response, RT-23). */
	blobPossessionProof?: boolean
	/** Fields 41-42: a throttled blob-chunk-response and its retry delay (RT-24). */
	throttled?: boolean
	retryAfterMs?: number
	/** Fields 43-44: the accepted view a handshake resumes (SYNC-11). */
	acceptedScopeKey?: string
	acceptedScopeWatermark?: number
	/** Field 45: the handshake's sequence-reservation capability (RT-37). */
	sequenceReservation?: boolean
	/** Field 46 (repeated): server-authoritative node ids (handshake-response, protocol v2). */
	authoritativeNodeIds?: string[]
	/** Field 47: sync protocol version (handshake and handshake-response, protocol v2). */
	protocolVersion?: number
	/** Field 48 (repeated): revoked explicit authoritative node ids (handshake-response, RT-81). */
	revokedAuthoritativeNodeIds?: string[]
}

function toProtoEnvelope(message: SyncMessage): ProtoEnvelope {
	switch (message.type) {
		case 'handshake':
			return {
				type: message.type,
				messageId: message.messageId,
				nodeId: message.nodeId,
				versionVector: Object.entries(message.versionVector).map(([key, value]) => ({
					key,
					value,
				})),
				schemaVersion: message.schemaVersion,
				authToken: message.authToken,
				supportedWireFormats: message.supportedWireFormats,
				...(message.lastDeliverySequence !== undefined
					? { lastDeliverySequence: message.lastDeliverySequence }
					: {}),
				...(message.acceptedScopeKey !== undefined
					? { acceptedScopeKey: message.acceptedScopeKey }
					: {}),
				...(message.acceptedScopeWatermark !== undefined
					? { acceptedScopeWatermark: message.acceptedScopeWatermark }
					: {}),
				scopeExitPolicy: message.scopeExitPolicy,
				...(message.nodeToken !== undefined ? { nodeToken: message.nodeToken } : {}),
				...(message.sequenceReservation !== undefined
					? { sequenceReservation: message.sequenceReservation }
					: {}),
				...(message.protocolVersion !== undefined
					? { protocolVersion: message.protocolVersion }
					: {}),
			}
		case 'handshake-response':
			return {
				type: message.type,
				messageId: message.messageId,
				nodeId: message.nodeId,
				versionVector: Object.entries(message.versionVector).map(([key, value]) => ({
					key,
					value,
				})),
				schemaVersion: message.schemaVersion,
				accepted: message.accepted,
				rejectReason: message.rejectReason,
				selectedWireFormat: message.selectedWireFormat,
				serverTime: message.serverTime,
				blobStorageEnabled: message.blobStorageEnabled,
				...(message.serverMaxDeliverySequence !== undefined
					? { serverMaxDeliverySequence: message.serverMaxDeliverySequence }
					: {}),
				acceptedScopeJson: message.acceptedScope
					? JSON.stringify(message.acceptedScope)
					: undefined,
				acceptedDownlinkScopesJson: message.acceptedDownlinkScopes
					? JSON.stringify(message.acceptedDownlinkScopes)
					: undefined,
				acceptedUplinkScopesJson: message.acceptedUplinkScopes
					? JSON.stringify(message.acceptedUplinkScopes)
					: undefined,
				...(message.nodeToken !== undefined ? { nodeToken: message.nodeToken } : {}),
				...(message.blobPossessionProof !== undefined
					? { blobPossessionProof: message.blobPossessionProof }
					: {}),
				...(message.protocolVersion !== undefined
					? { protocolVersion: message.protocolVersion }
					: {}),
				...(message.authoritativeNodeIds !== undefined
					? { authoritativeNodeIds: [...message.authoritativeNodeIds] }
					: {}),
				...(message.revokedAuthoritativeNodeIds !== undefined
					? { revokedAuthoritativeNodeIds: [...message.revokedAuthoritativeNodeIds] }
					: {}),
			}
		case 'operation-batch':
			return {
				type: message.type,
				messageId: message.messageId,
				operations: message.operations.map(serializeProtoOperation),
				isFinal: message.isFinal,
				batchIndex: message.batchIndex,
				...(message.baseDeliverySequence !== undefined
					? { baseDeliverySequence: message.baseDeliverySequence }
					: {}),
				...(message.maxDeliverySequence !== undefined
					? { maxDeliverySequence: message.maxDeliverySequence }
					: {}),
				retractionsJson: message.retractions ? JSON.stringify(message.retractions) : undefined,
			}
		case 'acknowledgment':
			return {
				type: message.type,
				messageId: message.messageId,
				acknowledgedMessageId: message.acknowledgedMessageId,
				lastSequenceNumber: message.lastSequenceNumber,
				...(message.deliverySequence !== undefined
					? { deliverySequence: message.deliverySequence }
					: {}),
				...(message.nodeToken !== undefined ? { nodeToken: message.nodeToken } : {}),
			}
		case 'error':
			return {
				type: message.type,
				messageId: message.messageId,
				errorCode: message.code,
				errorMessage: message.message,
				retriable: message.retriable,
			}
		case 'operation-rejected':
			// Reuse errorCode/errorMessage/retriable (fields 16-18) for the shared
			// code/message/retriable; fields 26-28 carry the operation identity.
			return {
				type: message.type,
				messageId: message.messageId,
				operationId: message.operationId,
				collection: message.collection,
				recordId: message.recordId,
				errorCode: message.code,
				errorMessage: message.message,
				retriable: message.retriable,
			}
		case 'awareness-update':
		case 'yjs-doc-update':
			// Ephemeral presence/doc messages use JSON serialization only. Return a minimal envelope.
			return {
				type: message.type,
				messageId: message.messageId,
			}
		case 'blob-chunk-request':
			return {
				type: message.type,
				messageId: message.messageId,
				requestId: message.requestId,
				hash: message.hash,
			}
		case 'blob-chunk-response':
			// Blob chunks carry durable user data, so they are fully represented on the
			// protobuf wire (not JSON-only). hasBytes distinguishes a held chunk from
			// "not held" (bytes === null), which an empty string alone could not.
			return {
				type: message.type,
				messageId: message.messageId,
				requestId: message.requestId,
				hasBytes: message.bytes !== null,
				...(message.bytes !== null ? { chunkBytes: message.bytes } : {}),
				...(message.throttled ? { throttled: true } : {}),
				...(message.retryAfterMs !== undefined ? { retryAfterMs: message.retryAfterMs } : {}),
			}
		case 'blob-chunk-push':
			return {
				type: message.type,
				messageId: message.messageId,
				hash: message.hash,
				chunkBytes: message.bytes,
			}
		case 'heartbeat':
			return { type: message.type, messageId: message.messageId }
		case 'encryption-key-request':
		case 'encryption-key-put':
		case 'encryption-key-response':
			// Key distribution is JSON on every wire format (ENC-1): NegotiatedMessageSerializer
			// sends it as a JSON text frame, never through the protobuf envelope.
			throw new SyncError('Encryption key messages travel as JSON', { type: message.type })
	}
}

function fromProtoEnvelope(envelope: ProtoEnvelope): SyncMessage {
	switch (envelope.type) {
		case 'handshake':
			return {
				type: 'handshake',
				messageId: envelope.messageId,
				nodeId: envelope.nodeId ?? '',
				versionVector: Object.fromEntries(
					(envelope.versionVector ?? []).map((entry) => [entry.key, entry.value]),
				),
				schemaVersion: envelope.schemaVersion ?? 0,
				authToken: envelope.authToken,
				supportedWireFormats: envelope.supportedWireFormats?.filter(
					(format): format is WireFormat => format === 'json' || format === 'protobuf',
				),
				...(envelope.lastDeliverySequence !== undefined
					? { lastDeliverySequence: envelope.lastDeliverySequence }
					: {}),
				...(envelope.acceptedScopeKey !== undefined
					? { acceptedScopeKey: envelope.acceptedScopeKey }
					: {}),
				...(envelope.acceptedScopeWatermark !== undefined
					? { acceptedScopeWatermark: envelope.acceptedScopeWatermark }
					: {}),
				...(envelope.scopeExitPolicy === 'retain' || envelope.scopeExitPolicy === 'retract'
					? { scopeExitPolicy: envelope.scopeExitPolicy }
					: {}),
				...(envelope.nodeToken ? { nodeToken: envelope.nodeToken } : {}),
				...(envelope.sequenceReservation !== undefined
					? { sequenceReservation: envelope.sequenceReservation }
					: {}),
				...(envelope.protocolVersion !== undefined
					? { protocolVersion: envelope.protocolVersion }
					: {}),
			}
		case 'handshake-response':
			return {
				type: 'handshake-response',
				messageId: envelope.messageId,
				nodeId: envelope.nodeId ?? '',
				versionVector: Object.fromEntries(
					(envelope.versionVector ?? []).map((entry) => [entry.key, entry.value]),
				),
				schemaVersion: envelope.schemaVersion ?? 0,
				accepted: envelope.accepted ?? false,
				rejectReason: envelope.rejectReason,
				selectedWireFormat:
					envelope.selectedWireFormat === 'json' || envelope.selectedWireFormat === 'protobuf'
						? envelope.selectedWireFormat
						: undefined,
				// Preserve the server's wall-clock time so clock-skew detection and
				// automatic timestamp rebase work over the protobuf wire, not just JSON.
				...(envelope.serverTime !== undefined ? { serverTime: envelope.serverTime } : {}),
				...(envelope.blobStorageEnabled !== undefined
					? { blobStorageEnabled: envelope.blobStorageEnabled }
					: {}),
				...(envelope.serverMaxDeliverySequence !== undefined
					? { serverMaxDeliverySequence: envelope.serverMaxDeliverySequence }
					: {}),
				...(envelope.acceptedScopeJson
					? { acceptedScope: JSON.parse(envelope.acceptedScopeJson) }
					: {}),
				...(envelope.acceptedDownlinkScopesJson
					? { acceptedDownlinkScopes: JSON.parse(envelope.acceptedDownlinkScopesJson) }
					: {}),
				...(envelope.acceptedUplinkScopesJson
					? { acceptedUplinkScopes: JSON.parse(envelope.acceptedUplinkScopesJson) }
					: {}),
				...(envelope.nodeToken ? { nodeToken: envelope.nodeToken } : {}),
				...(envelope.blobPossessionProof !== undefined
					? { blobPossessionProof: envelope.blobPossessionProof }
					: {}),
				...(envelope.protocolVersion !== undefined
					? { protocolVersion: envelope.protocolVersion }
					: {}),
				...(envelope.authoritativeNodeIds !== undefined
					? { authoritativeNodeIds: envelope.authoritativeNodeIds }
					: {}),
				...(envelope.revokedAuthoritativeNodeIds !== undefined
					? { revokedAuthoritativeNodeIds: envelope.revokedAuthoritativeNodeIds }
					: {}),
			}
		case 'operation-batch':
			return {
				type: 'operation-batch',
				messageId: envelope.messageId,
				operations: (envelope.operations ?? []).map(deserializeProtoOperation),
				isFinal: envelope.isFinal ?? false,
				batchIndex: envelope.batchIndex ?? 0,
				...(envelope.baseDeliverySequence !== undefined
					? { baseDeliverySequence: envelope.baseDeliverySequence }
					: {}),
				...(envelope.maxDeliverySequence !== undefined
					? { maxDeliverySequence: envelope.maxDeliverySequence }
					: {}),
				...(envelope.retractionsJson ? { retractions: JSON.parse(envelope.retractionsJson) } : {}),
			}
		case 'acknowledgment':
			return {
				type: 'acknowledgment',
				messageId: envelope.messageId,
				acknowledgedMessageId: envelope.acknowledgedMessageId ?? '',
				lastSequenceNumber: envelope.lastSequenceNumber ?? 0,
				...(envelope.deliverySequence !== undefined
					? { deliverySequence: envelope.deliverySequence }
					: {}),
				...(envelope.nodeToken ? { nodeToken: envelope.nodeToken } : {}),
			}
		case 'error':
			return {
				type: 'error',
				messageId: envelope.messageId,
				code: envelope.errorCode ?? 'UNKNOWN',
				message: envelope.errorMessage ?? 'Unknown error',
				retriable: envelope.retriable ?? false,
			}
		case 'operation-rejected':
			return {
				type: 'operation-rejected',
				messageId: envelope.messageId,
				operationId: envelope.operationId ?? '',
				collection: envelope.collection ?? '',
				recordId: envelope.recordId ?? '',
				code: envelope.errorCode ?? 'REJECTED',
				message: envelope.errorMessage ?? '',
				retriable: envelope.retriable ?? false,
			}
		case 'blob-chunk-request':
			return {
				type: 'blob-chunk-request',
				messageId: envelope.messageId,
				requestId: envelope.requestId ?? '',
				hash: envelope.hash ?? '',
			}
		case 'blob-chunk-response':
			return {
				type: 'blob-chunk-response',
				messageId: envelope.messageId,
				requestId: envelope.requestId ?? '',
				bytes: envelope.hasBytes ? (envelope.chunkBytes ?? '') : null,
				...(envelope.throttled ? { throttled: true } : {}),
				...(envelope.retryAfterMs !== undefined ? { retryAfterMs: envelope.retryAfterMs } : {}),
			}
		case 'blob-chunk-push':
			return {
				type: 'blob-chunk-push',
				messageId: envelope.messageId,
				hash: envelope.hash ?? '',
				bytes: envelope.chunkBytes ?? '',
			}
		case 'heartbeat':
			return { type: 'heartbeat', messageId: envelope.messageId }
		default:
			throw new SyncError('Failed to decode sync message: unknown protobuf type', {
				type: envelope.type,
			})
	}
}

function serializeProtoOperation(operation: SerializedOperation): ProtoOperation {
	// Embed metadata in the data JSON when present (piggyback on existing field)
	const hasMetadata =
		operation.transactionId !== undefined ||
		operation.mutationName !== undefined ||
		(operation.atomicOps !== undefined && Object.keys(operation.atomicOps).length > 0)
	let dataJson = ''
	if (operation.data !== null) {
		const dataPayload: Record<string, unknown> = { ...operation.data }
		if (operation.atomicOps !== undefined && Object.keys(operation.atomicOps).length > 0) {
			dataPayload.__kora_atomic_ops__ = operation.atomicOps
		}
		if (operation.transactionId !== undefined) {
			dataPayload.__kora_tx_id__ = operation.transactionId
		}
		if (operation.mutationName !== undefined) {
			dataPayload.__kora_mutation__ = operation.mutationName
		}
		if (operation.fieldVersions !== undefined) {
			dataPayload.__kora_field_versions__ = operation.fieldVersions
		}
		dataJson = JSON.stringify(dataPayload)
	} else if (hasMetadata) {
		// For operations without data (deletes), still carry metadata. hasData stays
		// false, so the decoder keeps data null.
		const meta: Record<string, unknown> = {}
		if (operation.atomicOps !== undefined && Object.keys(operation.atomicOps).length > 0) {
			meta.__kora_atomic_ops__ = operation.atomicOps
		}
		if (operation.transactionId !== undefined) meta.__kora_tx_id__ = operation.transactionId
		if (operation.mutationName !== undefined) meta.__kora_mutation__ = operation.mutationName
		dataJson = JSON.stringify(meta)
	}

	return {
		id: operation.id,
		nodeId: operation.nodeId,
		type: operation.type,
		collection: operation.collection,
		recordId: operation.recordId,
		dataJson,
		previousDataJson: operation.previousData === null ? '' : JSON.stringify(operation.previousData),
		timestamp: {
			wallTime: operation.timestamp.wallTime,
			logical: operation.timestamp.logical,
			nodeId: operation.timestamp.nodeId,
		},
		sequenceNumber: operation.sequenceNumber,
		causalDeps: [...operation.causalDeps],
		schemaVersion: operation.schemaVersion,
		hasData: operation.data !== null,
		hasPreviousData: operation.previousData !== null,
		...(operation.hashVersion !== undefined ? { hashVersion: operation.hashVersion } : {}),
		...(operation.foldState !== undefined ? { foldState: operation.foldState } : {}),
		...(operation.encrypted !== undefined
			? { encryptedJson: JSON.stringify(operation.encrypted) }
			: {}),
	}
}

function deserializeProtoOperation(operation: ProtoOperation): SerializedOperation {
	let data: Record<string, unknown> | null = null
	let atomicOps: Record<string, unknown> | undefined
	let transactionId: string | undefined
	let mutationName: string | undefined
	let fieldVersions: Record<string, HLCTimestamp> | undefined

	if (operation.hasData || operation.dataJson.length > 0) {
		const parsed = JSON.parse(operation.dataJson) as Record<string, unknown>
		if ('__kora_atomic_ops__' in parsed) {
			atomicOps = parsed.__kora_atomic_ops__ as Record<string, unknown>
		}
		if ('__kora_tx_id__' in parsed) {
			transactionId = parsed.__kora_tx_id__ as string
		}
		if ('__kora_mutation__' in parsed) {
			mutationName = parsed.__kora_mutation__ as string
		}
		if ('__kora_field_versions__' in parsed) {
			fieldVersions = normalizeFieldVersions(parsed.__kora_field_versions__)
		}
		const {
			__kora_atomic_ops__: _a,
			__kora_tx_id__: _t,
			__kora_mutation__: _m,
			__kora_field_versions__: _f,
			...rest
		} = parsed
		// `hasData` says whether the op carried data: `{}` stays `{}` (its id covers it).
		data = operation.hasData ? rest : null
	}

	return {
		id: operation.id,
		nodeId: operation.nodeId,
		type: operation.type as SerializedOperation['type'],
		collection: operation.collection,
		recordId: operation.recordId,
		data,
		previousData: operation.hasPreviousData
			? (JSON.parse(operation.previousDataJson) as Record<string, unknown>)
			: null,
		timestamp: {
			wallTime: operation.timestamp.wallTime,
			logical: operation.timestamp.logical,
			nodeId: operation.timestamp.nodeId,
		},
		sequenceNumber: operation.sequenceNumber,
		causalDeps: [...operation.causalDeps],
		schemaVersion: operation.schemaVersion,
		...(atomicOps !== undefined
			? { atomicOps: atomicOps as SerializedOperation['atomicOps'] }
			: {}),
		...(transactionId !== undefined ? { transactionId } : {}),
		...(mutationName !== undefined ? { mutationName } : {}),
		...(fieldVersions !== undefined ? { fieldVersions } : {}),
		...(operation.hashVersion !== undefined && operation.hashVersion !== 0
			? { hashVersion: operation.hashVersion as 1 | 2 }
			: {}),
		...(operation.foldState !== undefined ? { foldState: operation.foldState } : {}),
		...decodeEnvelopeJson(operation.encryptedJson),
	}
}

function decodeEnvelopeJson(json: string | undefined): {
	encrypted?: EncryptedOperationEnvelope
} {
	if (json === undefined || json.length === 0) return {}
	let parsed: unknown
	try {
		parsed = JSON.parse(json)
	} catch {
		throw new SyncError('Failed to decode sync message: invalid encryption envelope JSON', {
			length: json.length,
		})
	}
	const encrypted = normalizeEnvelope(parsed)
	return encrypted !== undefined ? { encrypted } : {}
}

function decodeTextPayload(data: string | Uint8Array | ArrayBuffer): string {
	if (typeof data === 'string') return data
	return new TextDecoder().decode(toBytes(data))
}

function toBytes(data: string | Uint8Array | ArrayBuffer): Uint8Array {
	if (typeof data === 'string') {
		return new TextEncoder().encode(data)
	}

	if (data instanceof Uint8Array) {
		return data
	}

	if (data instanceof ArrayBuffer) {
		return new Uint8Array(data)
	}

	throw new SyncError('Unsupported sync payload type', { receivedType: typeof data })
}

function encodeEnvelope(envelope: ProtoEnvelope): Uint8Array {
	const writer = Writer.create()
	if (envelope.type.length > 0) writer.uint32(10).string(envelope.type)
	if (envelope.messageId.length > 0) writer.uint32(18).string(envelope.messageId)
	if (envelope.nodeId && envelope.nodeId.length > 0) writer.uint32(26).string(envelope.nodeId)
	for (const entry of envelope.versionVector ?? []) {
		writer.uint32(34).fork()
		writer.uint32(10).string(entry.key)
		writer.uint32(16).int64(entry.value)
		writer.ldelim()
	}
	if (envelope.schemaVersion !== undefined) writer.uint32(40).int32(envelope.schemaVersion)
	if (envelope.authToken && envelope.authToken.length > 0)
		writer.uint32(50).string(envelope.authToken)
	for (const format of envelope.supportedWireFormats ?? []) {
		writer.uint32(58).string(format)
	}
	if (envelope.accepted !== undefined) writer.uint32(64).bool(envelope.accepted)
	if (envelope.rejectReason && envelope.rejectReason.length > 0)
		writer.uint32(74).string(envelope.rejectReason)
	if (envelope.selectedWireFormat && envelope.selectedWireFormat.length > 0) {
		writer.uint32(82).string(envelope.selectedWireFormat)
	}
	for (const operation of envelope.operations ?? []) {
		writer.uint32(90).fork()
		encodeProtoOperation(writer, operation)
		writer.ldelim()
	}
	if (envelope.isFinal !== undefined) writer.uint32(96).bool(envelope.isFinal)
	if (envelope.batchIndex !== undefined) writer.uint32(104).uint32(envelope.batchIndex)
	if (envelope.acknowledgedMessageId && envelope.acknowledgedMessageId.length > 0) {
		writer.uint32(114).string(envelope.acknowledgedMessageId)
	}
	if (envelope.lastSequenceNumber !== undefined)
		writer.uint32(120).int64(envelope.lastSequenceNumber)
	if (envelope.errorCode && envelope.errorCode.length > 0)
		writer.uint32(130).string(envelope.errorCode)
	if (envelope.errorMessage && envelope.errorMessage.length > 0) {
		writer.uint32(138).string(envelope.errorMessage)
	}
	if (envelope.retriable !== undefined) writer.uint32(144).bool(envelope.retriable)
	// Field 19: server wall-clock time (ms epoch). Optional; only handshake-response sets it.
	if (envelope.serverTime !== undefined) writer.uint32(152).int64(envelope.serverTime)
	// Fields 20-23: blob chunk side channel (out-of-band blob transfer).
	if (envelope.requestId && envelope.requestId.length > 0)
		writer.uint32(162).string(envelope.requestId)
	if (envelope.hash && envelope.hash.length > 0) writer.uint32(170).string(envelope.hash)
	if (envelope.chunkBytes && envelope.chunkBytes.length > 0)
		writer.uint32(178).string(envelope.chunkBytes)
	if (envelope.hasBytes !== undefined) writer.uint32(184).bool(envelope.hasBytes)
	// Field 25: server advertises central blob storage (handshake-response).
	if (envelope.blobStorageEnabled !== undefined)
		writer.uint32(200).bool(envelope.blobStorageEnabled)
	// Fields 26-28: per-operation rejection identity (operation-rejected).
	if (envelope.operationId && envelope.operationId.length > 0)
		writer.uint32(210).string(envelope.operationId)
	if (envelope.collection && envelope.collection.length > 0)
		writer.uint32(218).string(envelope.collection)
	if (envelope.recordId && envelope.recordId.length > 0)
		writer.uint32(226).string(envelope.recordId)
	// Fields 29-32: delivery-watermark protocol. int64 (field << 3 | wiretype 0).
	if (envelope.lastDeliverySequence !== undefined)
		writer.uint32(232).int64(envelope.lastDeliverySequence)
	if (envelope.baseDeliverySequence !== undefined)
		writer.uint32(240).int64(envelope.baseDeliverySequence)
	if (envelope.maxDeliverySequence !== undefined)
		writer.uint32(248).int64(envelope.maxDeliverySequence)
	if (envelope.deliverySequence !== undefined) writer.uint32(256).int64(envelope.deliverySequence)
	if (envelope.serverMaxDeliverySequence !== undefined)
		writer.uint32(264).int64(envelope.serverMaxDeliverySequence)
	if (envelope.acceptedScopeJson) writer.uint32(274).string(envelope.acceptedScopeJson)
	if (envelope.acceptedDownlinkScopesJson)
		writer.uint32(282).string(envelope.acceptedDownlinkScopesJson)
	if (envelope.acceptedUplinkScopesJson)
		writer.uint32(290).string(envelope.acceptedUplinkScopesJson)
	if (envelope.retractionsJson) writer.uint32(298).string(envelope.retractionsJson)
	if (envelope.scopeExitPolicy) writer.uint32(306).string(envelope.scopeExitPolicy)
	if (envelope.nodeToken) writer.uint32(314).string(envelope.nodeToken)
	// Field 40 (bool, wiretype 0): 40 << 3 = 320. Fields 41-42: 328, 336.
	if (envelope.blobPossessionProof !== undefined)
		writer.uint32(320).bool(envelope.blobPossessionProof)
	if (envelope.throttled) writer.uint32(328).bool(envelope.throttled)
	if (envelope.retryAfterMs !== undefined) writer.uint32(336).int64(envelope.retryAfterMs)
	if (envelope.acceptedScopeKey !== undefined) writer.uint32(346).string(envelope.acceptedScopeKey)
	if (envelope.acceptedScopeWatermark !== undefined)
		writer.uint32(352).int64(envelope.acceptedScopeWatermark)
	// Field 45 (bool, wiretype 0): 45 << 3 = 360. Written whenever set (false included),
	// so a client that explicitly opts out is told apart from one that predates it.
	if (envelope.sequenceReservation !== undefined)
		writer.uint32(360).bool(envelope.sequenceReservation)
	// Field 46 (repeated string, wiretype 2): 46 << 3 | 2 = 370.
	for (const nodeId of envelope.authoritativeNodeIds ?? []) writer.uint32(370).string(nodeId)
	// Field 47 (uint32, wiretype 0): 47 << 3 = 376.
	if (envelope.protocolVersion !== undefined) writer.uint32(376).uint32(envelope.protocolVersion)
	// Field 48 (repeated string, wiretype 2): 48 << 3 | 2 = 386.
	for (const nodeId of envelope.revokedAuthoritativeNodeIds ?? []) writer.uint32(386).string(nodeId)
	return writer.finish()
}

function decodeEnvelope(bytes: Uint8Array): ProtoEnvelope {
	const reader = Reader.create(bytes)
	const envelope: ProtoEnvelope = { type: 'error', messageId: '' }

	while (reader.pos < reader.len) {
		const tag = reader.uint32()
		switch (tag >>> 3) {
			case 1:
				envelope.type = reader.string() as SyncMessage['type']
				break
			case 2:
				envelope.messageId = reader.string()
				break
			case 3:
				envelope.nodeId = reader.string()
				break
			case 4:
				envelope.versionVector = [
					...(envelope.versionVector ?? []),
					decodeVectorEntry(reader, reader.uint32()),
				]
				break
			case 5:
				envelope.schemaVersion = reader.int32()
				break
			case 6:
				envelope.authToken = reader.string()
				break
			case 7:
				envelope.supportedWireFormats = [...(envelope.supportedWireFormats ?? []), reader.string()]
				break
			case 8:
				envelope.accepted = reader.bool()
				break
			case 9:
				envelope.rejectReason = reader.string()
				break
			case 10:
				envelope.selectedWireFormat = reader.string()
				break
			case 11:
				envelope.operations = [
					...(envelope.operations ?? []),
					decodeProtoOperation(reader, reader.uint32()),
				]
				break
			case 12:
				envelope.isFinal = reader.bool()
				break
			case 13:
				envelope.batchIndex = reader.uint32()
				break
			case 14:
				envelope.acknowledgedMessageId = reader.string()
				break
			case 15:
				envelope.lastSequenceNumber = longToNumber(reader.int64())
				break
			case 16:
				envelope.errorCode = reader.string()
				break
			case 17:
				envelope.errorMessage = reader.string()
				break
			case 18:
				envelope.retriable = reader.bool()
				break
			case 19:
				envelope.serverTime = longToNumber(reader.int64())
				break
			case 20:
				envelope.requestId = reader.string()
				break
			case 21:
				envelope.hash = reader.string()
				break
			case 22:
				envelope.chunkBytes = reader.string()
				break
			case 23:
				envelope.hasBytes = reader.bool()
				break
			case 25:
				envelope.blobStorageEnabled = reader.bool()
				break
			case 26:
				envelope.operationId = reader.string()
				break
			case 27:
				envelope.collection = reader.string()
				break
			case 28:
				envelope.recordId = reader.string()
				break
			case 29:
				envelope.lastDeliverySequence = longToNumber(reader.int64())
				break
			case 30:
				envelope.baseDeliverySequence = longToNumber(reader.int64())
				break
			case 31:
				envelope.maxDeliverySequence = longToNumber(reader.int64())
				break
			case 32:
				envelope.deliverySequence = longToNumber(reader.int64())
				break
			case 33:
				envelope.serverMaxDeliverySequence = longToNumber(reader.int64())
				break
			case 34:
				envelope.acceptedScopeJson = reader.string()
				break
			case 35:
				envelope.acceptedDownlinkScopesJson = reader.string()
				break
			case 36:
				envelope.acceptedUplinkScopesJson = reader.string()
				break
			case 37:
				envelope.retractionsJson = reader.string()
				break
			case 38:
				envelope.scopeExitPolicy = reader.string()
				break
			case 39:
				envelope.nodeToken = reader.string()
				break
			case 40:
				envelope.blobPossessionProof = reader.bool()
				break
			case 41:
				envelope.throttled = reader.bool()
				break
			case 42:
				envelope.retryAfterMs = longToNumber(reader.int64())
				break
			case 43:
				envelope.acceptedScopeKey = reader.string()
				break
			case 44:
				envelope.acceptedScopeWatermark = longToNumber(reader.int64())
				break
			case 45:
				envelope.sequenceReservation = reader.bool()
				break
			case 46:
				envelope.authoritativeNodeIds = [...(envelope.authoritativeNodeIds ?? []), reader.string()]
				break
			case 47:
				envelope.protocolVersion = reader.uint32()
				break
			case 48:
				envelope.revokedAuthoritativeNodeIds = [
					...(envelope.revokedAuthoritativeNodeIds ?? []),
					reader.string(),
				]
				break
			default:
				reader.skipType(tag & 7)
		}
	}

	return envelope
}

function encodeProtoOperation(writer: Writer, operation: ProtoOperation): void {
	if (operation.id.length > 0) writer.uint32(10).string(operation.id)
	if (operation.nodeId.length > 0) writer.uint32(18).string(operation.nodeId)
	if (operation.type.length > 0) writer.uint32(26).string(operation.type)
	if (operation.collection.length > 0) writer.uint32(34).string(operation.collection)
	if (operation.recordId.length > 0) writer.uint32(42).string(operation.recordId)
	if (operation.dataJson.length > 0) writer.uint32(50).string(operation.dataJson)
	if (operation.previousDataJson.length > 0) writer.uint32(58).string(operation.previousDataJson)
	writer.uint32(66).fork()
	writer.uint32(8).int64(operation.timestamp.wallTime)
	writer.uint32(16).uint32(operation.timestamp.logical)
	writer.uint32(26).string(operation.timestamp.nodeId)
	writer.ldelim()
	writer.uint32(72).int64(operation.sequenceNumber)
	for (const dep of operation.causalDeps) {
		writer.uint32(82).string(dep)
	}
	writer.uint32(88).int32(operation.schemaVersion)
	writer.uint32(96).bool(operation.hasData)
	writer.uint32(104).bool(operation.hasPreviousData)
	// Fields 14-16 (protocol v2). Older decoders skip them as unknown fields.
	if (operation.hashVersion !== undefined) writer.uint32(112).uint32(operation.hashVersion)
	if (operation.foldState !== undefined) writer.uint32(122).string(operation.foldState)
	if (operation.encryptedJson !== undefined) writer.uint32(130).string(operation.encryptedJson)
}

function decodeProtoOperation(reader: Reader, length: number): ProtoOperation {
	const end = reader.pos + length
	const operation: ProtoOperation = {
		id: '',
		nodeId: '',
		type: 'insert',
		collection: '',
		recordId: '',
		dataJson: '',
		previousDataJson: '',
		timestamp: { wallTime: 0, logical: 0, nodeId: '' },
		sequenceNumber: 0,
		causalDeps: [],
		schemaVersion: 0,
		hasData: false,
		hasPreviousData: false,
	}

	while (reader.pos < end) {
		const tag = reader.uint32()
		switch (tag >>> 3) {
			case 1:
				operation.id = reader.string()
				break
			case 2:
				operation.nodeId = reader.string()
				break
			case 3:
				operation.type = reader.string()
				break
			case 4:
				operation.collection = reader.string()
				break
			case 5:
				operation.recordId = reader.string()
				break
			case 6:
				operation.dataJson = reader.string()
				break
			case 7:
				operation.previousDataJson = reader.string()
				break
			case 8: {
				const timestampEnd = reader.pos + reader.uint32()
				while (reader.pos < timestampEnd) {
					const timestampTag = reader.uint32()
					switch (timestampTag >>> 3) {
						case 1:
							operation.timestamp.wallTime = longToNumber(reader.int64())
							break
						case 2:
							operation.timestamp.logical = reader.uint32()
							break
						case 3:
							operation.timestamp.nodeId = reader.string()
							break
						default:
							reader.skipType(timestampTag & 7)
					}
				}
				break
			}
			case 9:
				operation.sequenceNumber = longToNumber(reader.int64())
				break
			case 10:
				operation.causalDeps.push(reader.string())
				break
			case 11:
				operation.schemaVersion = reader.int32()
				break
			case 12:
				operation.hasData = reader.bool()
				break
			case 13:
				operation.hasPreviousData = reader.bool()
				break
			case 14:
				operation.hashVersion = reader.uint32()
				break
			case 15:
				operation.foldState = reader.string()
				break
			case 16:
				operation.encryptedJson = reader.string()
				break
			default:
				reader.skipType(tag & 7)
		}
	}

	return operation
}

function decodeVectorEntry(reader: Reader, length: number): ProtoVectorEntry {
	const end = reader.pos + length
	const entry: ProtoVectorEntry = { key: '', value: 0 }
	while (reader.pos < end) {
		const tag = reader.uint32()
		switch (tag >>> 3) {
			case 1:
				entry.key = reader.string()
				break
			case 2:
				entry.value = longToNumber(reader.int64())
				break
			default:
				reader.skipType(tag & 7)
		}
	}
	return entry
}

function longToNumber(value: unknown): number {
	if (typeof value === 'number') return value
	if (typeof value === 'string') return Number.parseInt(value, 10)
	if (
		typeof value === 'object' &&
		value !== null &&
		'toNumber' in value &&
		typeof (value as { toNumber: unknown }).toNumber === 'function'
	) {
		return (value as { toNumber(): number }).toNumber()
	}

	throw new SyncError('Failed to decode int64 value', {
		receivedType: typeof value,
	})
}

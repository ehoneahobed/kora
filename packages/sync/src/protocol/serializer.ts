import { SyncError } from '@korajs/core'
import type {
	EncryptedOperationEnvelope,
	HLCTimestamp,
	Operation,
	VersionVector,
} from '@korajs/core'
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
 * (beta.12 richtext). Any other object is data and is returned as is.
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

/** Text of a JSON wire frame. */
function decodeTextPayload(data: string | Uint8Array | ArrayBuffer): string {
	if (typeof data === 'string') return data
	return new TextDecoder().decode(toBytes(data))
}

/** The bytes of a wire payload (shared with the opt-in protobuf serializer). */
export function toBytes(data: string | Uint8Array | ArrayBuffer): Uint8Array {
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

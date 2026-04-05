import { SyncError } from '@korajs/core'
import type { Operation, VersionVector } from '@korajs/core'
import { Reader, Writer } from 'protobufjs/minimal'
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
			data: op.data,
			previousData: op.previousData,
			timestamp: {
				wallTime: op.timestamp.wallTime,
				logical: op.timestamp.logical,
				nodeId: op.timestamp.nodeId,
			},
			sequenceNumber: op.sequenceNumber,
			causalDeps: [...op.causalDeps],
			schemaVersion: op.schemaVersion,
		}
	}

	decodeOperation(serialized: SerializedOperation): Operation {
		return {
			id: serialized.id,
			nodeId: serialized.nodeId,
			type: serialized.type,
			collection: serialized.collection,
			recordId: serialized.recordId,
			data: serialized.data,
			previousData: serialized.previousData,
			timestamp: {
				wallTime: serialized.timestamp.wallTime,
				logical: serialized.timestamp.logical,
				nodeId: serialized.timestamp.nodeId,
			},
			sequenceNumber: serialized.sequenceNumber,
			causalDeps: [...serialized.causalDeps],
			schemaVersion: serialized.schemaVersion,
		}
	}
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
		if (this.wireFormat === 'protobuf') {
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
	operations?: ProtoOperation[]
	isFinal?: boolean
	batchIndex?: number
	acknowledgedMessageId?: string
	lastSequenceNumber?: number
	errorCode?: string
	errorMessage?: string
	retriable?: boolean
}

function toProtoEnvelope(message: SyncMessage): ProtoEnvelope {
	switch (message.type) {
		case 'handshake':
			return {
				type: message.type,
				messageId: message.messageId,
				nodeId: message.nodeId,
				versionVector: Object.entries(message.versionVector).map(([key, value]) => ({ key, value })),
				schemaVersion: message.schemaVersion,
				authToken: message.authToken,
				supportedWireFormats: message.supportedWireFormats,
			}
		case 'handshake-response':
			return {
				type: message.type,
				messageId: message.messageId,
				nodeId: message.nodeId,
				versionVector: Object.entries(message.versionVector).map(([key, value]) => ({ key, value })),
				schemaVersion: message.schemaVersion,
				accepted: message.accepted,
				rejectReason: message.rejectReason,
				selectedWireFormat: message.selectedWireFormat,
			}
		case 'operation-batch':
			return {
				type: message.type,
				messageId: message.messageId,
				operations: message.operations.map(serializeProtoOperation),
				isFinal: message.isFinal,
				batchIndex: message.batchIndex,
			}
		case 'acknowledgment':
			return {
				type: message.type,
				messageId: message.messageId,
				acknowledgedMessageId: message.acknowledgedMessageId,
				lastSequenceNumber: message.lastSequenceNumber,
			}
		case 'error':
			return {
				type: message.type,
				messageId: message.messageId,
				errorCode: message.code,
				errorMessage: message.message,
				retriable: message.retriable,
			}
	}
}

function fromProtoEnvelope(envelope: ProtoEnvelope): SyncMessage {
	switch (envelope.type) {
		case 'handshake':
			return {
				type: 'handshake',
				messageId: envelope.messageId,
				nodeId: envelope.nodeId ?? '',
				versionVector: Object.fromEntries((envelope.versionVector ?? []).map((entry) => [entry.key, entry.value])),
				schemaVersion: envelope.schemaVersion ?? 0,
				authToken: envelope.authToken,
				supportedWireFormats:
					envelope.supportedWireFormats?.filter(
						(format): format is WireFormat => format === 'json' || format === 'protobuf',
					),
			}
		case 'handshake-response':
			return {
				type: 'handshake-response',
				messageId: envelope.messageId,
				nodeId: envelope.nodeId ?? '',
				versionVector: Object.fromEntries((envelope.versionVector ?? []).map((entry) => [entry.key, entry.value])),
				schemaVersion: envelope.schemaVersion ?? 0,
				accepted: envelope.accepted ?? false,
				rejectReason: envelope.rejectReason,
				selectedWireFormat:
					envelope.selectedWireFormat === 'json' || envelope.selectedWireFormat === 'protobuf'
						? envelope.selectedWireFormat
						: undefined,
			}
		case 'operation-batch':
			return {
				type: 'operation-batch',
				messageId: envelope.messageId,
				operations: (envelope.operations ?? []).map(deserializeProtoOperation),
				isFinal: envelope.isFinal ?? false,
				batchIndex: envelope.batchIndex ?? 0,
			}
		case 'acknowledgment':
			return {
				type: 'acknowledgment',
				messageId: envelope.messageId,
				acknowledgedMessageId: envelope.acknowledgedMessageId ?? '',
				lastSequenceNumber: envelope.lastSequenceNumber ?? 0,
			}
		case 'error':
			return {
				type: 'error',
				messageId: envelope.messageId,
				code: envelope.errorCode ?? 'UNKNOWN',
				message: envelope.errorMessage ?? 'Unknown error',
				retriable: envelope.retriable ?? false,
			}
		default:
			throw new SyncError('Failed to decode sync message: unknown protobuf type', {
				type: envelope.type,
			})
	}
}

function serializeProtoOperation(operation: SerializedOperation): ProtoOperation {
	return {
		id: operation.id,
		nodeId: operation.nodeId,
		type: operation.type,
		collection: operation.collection,
		recordId: operation.recordId,
		dataJson: operation.data === null ? '' : JSON.stringify(operation.data),
		previousDataJson:
			operation.previousData === null ? '' : JSON.stringify(operation.previousData),
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
	}
}

function deserializeProtoOperation(operation: ProtoOperation): SerializedOperation {
	return {
		id: operation.id,
		nodeId: operation.nodeId,
		type: operation.type as SerializedOperation['type'],
		collection: operation.collection,
		recordId: operation.recordId,
		data: operation.hasData ? (JSON.parse(operation.dataJson) as Record<string, unknown>) : null,
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
	}
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
	if (envelope.authToken && envelope.authToken.length > 0) writer.uint32(50).string(envelope.authToken)
	for (const format of envelope.supportedWireFormats ?? []) {
		writer.uint32(58).string(format)
	}
	if (envelope.accepted !== undefined) writer.uint32(64).bool(envelope.accepted)
	if (envelope.rejectReason && envelope.rejectReason.length > 0) writer.uint32(74).string(envelope.rejectReason)
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
	if (envelope.lastSequenceNumber !== undefined) writer.uint32(120).int64(envelope.lastSequenceNumber)
	if (envelope.errorCode && envelope.errorCode.length > 0) writer.uint32(130).string(envelope.errorCode)
	if (envelope.errorMessage && envelope.errorMessage.length > 0) {
		writer.uint32(138).string(envelope.errorMessage)
	}
	if (envelope.retriable !== undefined) writer.uint32(144).bool(envelope.retriable)
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
				envelope.versionVector = [...(envelope.versionVector ?? []), decodeVectorEntry(reader, reader.uint32())]
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
				envelope.operations = [...(envelope.operations ?? []), decodeProtoOperation(reader, reader.uint32())]
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

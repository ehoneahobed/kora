import type { Operation, SchemaDefinition } from '@korajs/core'
import { SyncError, generateProtoSchema } from '@korajs/core'
import protobuf from 'protobufjs'
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
import type { EncodedMessage, MessageSerializer } from './serializer'
import { JsonMessageSerializer } from './serializer'

/**
 * Compiled protobuf root and message types, cached after first compilation.
 * Avoids recompiling the proto schema on every serialization call.
 */
interface CompiledProto {
	root: protobuf.Root
	SyncEnvelope: protobuf.Type
	Handshake: protobuf.Type
	HandshakeResponse: protobuf.Type
	OperationBatch: protobuf.Type
	Acknowledgment: protobuf.Type
	SyncError: protobuf.Type
	SyncOperation: protobuf.Type
	HLCTimestamp: protobuf.Type
}

/**
 * Schema-driven protobuf serializer that dynamically compiles .proto definitions
 * from a Kora SchemaDefinition at runtime using protobufjs reflection.
 *
 * Benefits over the static serializer:
 * - Schema changes automatically update the wire format
 * - No build step required for protobuf
 * - Collection-specific data can be type-checked against the schema
 *
 * The proto schema is compiled lazily on first use and cached for subsequent
 * serialize/deserialize calls.
 *
 * @example
 * ```typescript
 * const serializer = new DynamicProtobufSerializer(schema)
 * const bytes = serializer.encode(handshakeMessage)
 * const decoded = serializer.decode(bytes)
 * ```
 */
export class DynamicProtobufSerializer implements MessageSerializer {
	private readonly schema: SchemaDefinition
	private compiled: CompiledProto | null = null
	private readonly jsonSerializer = new JsonMessageSerializer()

	constructor(schema: SchemaDefinition) {
		this.schema = schema
	}

	/**
	 * Lazily compiles the proto schema on first use.
	 * The compiled root is cached for all subsequent calls.
	 */
	private compile(): CompiledProto {
		if (this.compiled !== null) {
			return this.compiled
		}

		const protoSource = generateProtoSchema(this.schema)
		const parsed = protobuf.parse(protoSource)
		const root = parsed.root

		const SyncEnvelope = root.lookupType('korajs.sync.SyncEnvelope')
		const Handshake = root.lookupType('korajs.sync.Handshake')
		const HandshakeResponse = root.lookupType('korajs.sync.HandshakeResponse')
		const OperationBatch = root.lookupType('korajs.sync.OperationBatch')
		const Acknowledgment = root.lookupType('korajs.sync.Acknowledgment')
		const SyncErrorType = root.lookupType('korajs.sync.SyncError')
		const SyncOperation = root.lookupType('korajs.sync.SyncOperation')
		const HLCTimestamp = root.lookupType('korajs.sync.HLCTimestamp')

		this.compiled = {
			root,
			SyncEnvelope,
			Handshake,
			HandshakeResponse,
			OperationBatch,
			Acknowledgment,
			SyncError: SyncErrorType,
			SyncOperation,
			HLCTimestamp,
		}

		return this.compiled
	}

	/**
	 * Encode a SyncMessage to binary protobuf bytes.
	 *
	 * @param message - The sync message to encode
	 * @returns A Uint8Array containing the protobuf-encoded message
	 */
	encode(message: SyncMessage): EncodedMessage {
		const compiled = this.compile()
		const envelope = this.toEnvelope(message)
		const verified = compiled.SyncEnvelope.verify(envelope)
		if (verified) {
			throw new SyncError(`Failed to encode sync message: ${verified}`, {
				messageType: message.type,
			})
		}
		const pbMessage = compiled.SyncEnvelope.create(envelope)
		return compiled.SyncEnvelope.encode(pbMessage).finish()
	}

	/**
	 * Decode binary protobuf bytes back to a SyncMessage.
	 *
	 * @param data - The protobuf-encoded bytes (Uint8Array, ArrayBuffer, or JSON string fallback)
	 * @returns The decoded SyncMessage
	 */
	decode(data: string | Uint8Array | ArrayBuffer): SyncMessage {
		// If string input, fall back to JSON
		if (typeof data === 'string') {
			return this.jsonSerializer.decode(data)
		}

		const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data
		const compiled = this.compile()
		const envelope = compiled.SyncEnvelope.decode(bytes)
		const plain = compiled.SyncEnvelope.toObject(envelope, {
			longs: Number,
			bytes: String,
			defaults: true,
		})
		return this.fromEnvelope(plain)
	}

	/**
	 * Convert an Operation to a SerializedOperation for wire transport.
	 */
	encodeOperation(op: Operation): SerializedOperation {
		return this.jsonSerializer.encodeOperation(op)
	}

	/**
	 * Convert a SerializedOperation back to an Operation.
	 */
	decodeOperation(serialized: SerializedOperation): Operation {
		return this.jsonSerializer.decodeOperation(serialized)
	}

	/**
	 * Convert a SyncMessage to a protobuf envelope object.
	 */
	private toEnvelope(message: SyncMessage): Record<string, unknown> {
		const envelope: Record<string, unknown> = { type: message.type }

		switch (message.type) {
			case 'handshake':
				envelope.handshake = this.toHandshakePayload(message)
				break
			case 'handshake-response':
				envelope.handshakeResponse = this.toHandshakeResponsePayload(message)
				break
			case 'operation-batch':
				envelope.operationBatch = this.toOperationBatchPayload(message)
				break
			case 'acknowledgment':
				envelope.acknowledgment = this.toAcknowledgmentPayload(message)
				break
			case 'error':
				envelope.error = this.toErrorPayload(message)
				break
		}

		return envelope
	}

	private toHandshakePayload(message: HandshakeMessage): Record<string, unknown> {
		return {
			messageId: message.messageId,
			nodeId: message.nodeId,
			versionVector: Object.entries(message.versionVector).map(([nodeId, sequenceNumber]) => ({
				nodeId,
				sequenceNumber,
			})),
			schemaVersion: message.schemaVersion,
			authToken: message.authToken ?? '',
			supportedWireFormats: message.supportedWireFormats ?? [],
			syncScopeJson: message.syncScope
				? new TextEncoder().encode(JSON.stringify(message.syncScope))
				: new Uint8Array(0),
		}
	}

	private toHandshakeResponsePayload(message: HandshakeResponseMessage): Record<string, unknown> {
		return {
			messageId: message.messageId,
			nodeId: message.nodeId,
			versionVector: Object.entries(message.versionVector).map(([nodeId, sequenceNumber]) => ({
				nodeId,
				sequenceNumber,
			})),
			schemaVersion: message.schemaVersion,
			accepted: message.accepted,
			rejectReason: message.rejectReason ?? '',
			selectedWireFormat: message.selectedWireFormat ?? '',
		}
	}

	private toOperationBatchPayload(message: OperationBatchMessage): Record<string, unknown> {
		return {
			messageId: message.messageId,
			operations: message.operations.map((op) => this.serializeOperation(op)),
			isFinal: message.isFinal,
			batchIndex: message.batchIndex,
		}
	}

	private toAcknowledgmentPayload(message: AcknowledgmentMessage): Record<string, unknown> {
		return {
			messageId: message.messageId,
			acknowledgedMessageId: message.acknowledgedMessageId,
			lastSequenceNumber: message.lastSequenceNumber,
		}
	}

	private toErrorPayload(message: ErrorMessage): Record<string, unknown> {
		return {
			messageId: message.messageId,
			code: message.code,
			message: message.message,
			retriable: message.retriable,
		}
	}

	/**
	 * Serialize an operation for the protobuf envelope.
	 * Operation data is JSON-encoded as bytes for forward compatibility with
	 * unknown collections. Known collections get the same treatment for
	 * consistency and backward compatibility with the static serializer.
	 */
	private serializeOperation(op: SerializedOperation): Record<string, unknown> {
		// Build data JSON, embedding metadata for backward compatibility
		const hasMetadata = op.transactionId !== undefined || op.mutationName !== undefined
		let dataJson = ''
		if (op.data !== null) {
			const dataPayload: Record<string, unknown> = { ...op.data }
			if (op.atomicOps !== undefined && Object.keys(op.atomicOps).length > 0) {
				dataPayload.__kora_atomic_ops__ = op.atomicOps
			}
			if (op.transactionId !== undefined) {
				dataPayload.__kora_tx_id__ = op.transactionId
			}
			if (op.mutationName !== undefined) {
				dataPayload.__kora_mutation__ = op.mutationName
			}
			dataJson = JSON.stringify(dataPayload)
		} else if (hasMetadata) {
			const meta: Record<string, unknown> = {}
			if (op.transactionId !== undefined) meta.__kora_tx_id__ = op.transactionId
			if (op.mutationName !== undefined) meta.__kora_mutation__ = op.mutationName
			dataJson = JSON.stringify(meta)
		}

		return {
			id: op.id,
			nodeId: op.nodeId,
			type: op.type,
			collection: op.collection,
			recordId: op.recordId,
			dataJson: new TextEncoder().encode(dataJson),
			previousDataJson:
				op.previousData !== null
					? new TextEncoder().encode(JSON.stringify(op.previousData))
					: new Uint8Array(0),
			timestamp: {
				wallTime: op.timestamp.wallTime,
				logical: op.timestamp.logical,
				nodeId: op.timestamp.nodeId,
			},
			sequenceNumber: op.sequenceNumber,
			causalDeps: [...op.causalDeps],
			schemaVersion: op.schemaVersion,
			hasData: op.data !== null,
			hasPreviousData: op.previousData !== null,
			atomicOps:
				op.atomicOps !== undefined
					? Object.fromEntries(
							Object.entries(op.atomicOps).map(([key, atomicOp]) => [
								key,
								{
									type: atomicOp.type,
									valueJson: new TextEncoder().encode(JSON.stringify(atomicOp.value)),
								},
							]),
						)
					: {},
			transactionId: op.transactionId ?? '',
			mutationName: op.mutationName ?? '',
		}
	}

	/**
	 * Convert a protobuf envelope object back to a SyncMessage.
	 */
	private fromEnvelope(envelope: Record<string, unknown>): SyncMessage {
		const type = envelope.type as string

		switch (type) {
			case 'handshake':
				return this.fromHandshakePayload(envelope.handshake as Record<string, unknown>)
			case 'handshake-response':
				return this.fromHandshakeResponsePayload(
					envelope.handshakeResponse as Record<string, unknown>,
				)
			case 'operation-batch':
				return this.fromOperationBatchPayload(envelope.operationBatch as Record<string, unknown>)
			case 'acknowledgment':
				return this.fromAcknowledgmentPayload(envelope.acknowledgment as Record<string, unknown>)
			case 'error':
				return this.fromErrorPayload(envelope.error as Record<string, unknown>)
			default:
				throw new SyncError('Failed to decode sync message: unknown protobuf type', {
					type,
				})
		}
	}

	private fromHandshakePayload(payload: Record<string, unknown>): HandshakeMessage {
		const versionVectorEntries = payload.versionVector as Array<Record<string, unknown>> | undefined
		const versionVector: Record<string, number> = {}
		if (versionVectorEntries) {
			for (const entry of versionVectorEntries) {
				const nodeId = entry.nodeId as string
				const seq = entry.sequenceNumber as number
				versionVector[nodeId] = seq
			}
		}

		const supportedWireFormats = (payload.supportedWireFormats as string[] | undefined)?.filter(
			(f): f is WireFormat => f === 'json' || f === 'protobuf',
		)

		let syncScope: Record<string, Record<string, unknown>> | undefined
		const scopeJson = payload.syncScopeJson as string | undefined
		if (scopeJson && scopeJson.length > 0) {
			try {
				// protobufjs decodes bytes as base64 strings with { bytes: String } option
				const decoded = atob(scopeJson)
				syncScope = JSON.parse(decoded) as Record<string, Record<string, unknown>>
			} catch {
				// Ignore invalid scope JSON — non-critical field
			}
		}

		return {
			type: 'handshake',
			messageId: payload.messageId as string,
			nodeId: payload.nodeId as string,
			versionVector,
			schemaVersion: (payload.schemaVersion as number) ?? 0,
			...(payload.authToken && (payload.authToken as string).length > 0
				? { authToken: payload.authToken as string }
				: {}),
			...(supportedWireFormats && supportedWireFormats.length > 0 ? { supportedWireFormats } : {}),
			...(syncScope ? { syncScope } : {}),
		}
	}

	private fromHandshakeResponsePayload(payload: Record<string, unknown>): HandshakeResponseMessage {
		const versionVectorEntries = payload.versionVector as Array<Record<string, unknown>> | undefined
		const versionVector: Record<string, number> = {}
		if (versionVectorEntries) {
			for (const entry of versionVectorEntries) {
				const nodeId = entry.nodeId as string
				const seq = entry.sequenceNumber as number
				versionVector[nodeId] = seq
			}
		}

		const selectedWireFormat = payload.selectedWireFormat as string | undefined
		const validFormat =
			selectedWireFormat === 'json' || selectedWireFormat === 'protobuf'
				? selectedWireFormat
				: undefined

		return {
			type: 'handshake-response',
			messageId: payload.messageId as string,
			nodeId: payload.nodeId as string,
			versionVector,
			schemaVersion: (payload.schemaVersion as number) ?? 0,
			accepted: (payload.accepted as boolean) ?? false,
			...(payload.rejectReason && (payload.rejectReason as string).length > 0
				? { rejectReason: payload.rejectReason as string }
				: {}),
			...(validFormat ? { selectedWireFormat: validFormat } : {}),
		}
	}

	private fromOperationBatchPayload(payload: Record<string, unknown>): OperationBatchMessage {
		const operations = (payload.operations as Array<Record<string, unknown>> | undefined) ?? []
		return {
			type: 'operation-batch',
			messageId: payload.messageId as string,
			operations: operations.map((op) => this.deserializeOperation(op)),
			isFinal: (payload.isFinal as boolean) ?? false,
			batchIndex: (payload.batchIndex as number) ?? 0,
		}
	}

	private fromAcknowledgmentPayload(payload: Record<string, unknown>): AcknowledgmentMessage {
		return {
			type: 'acknowledgment',
			messageId: payload.messageId as string,
			acknowledgedMessageId: (payload.acknowledgedMessageId as string) ?? '',
			lastSequenceNumber: (payload.lastSequenceNumber as number) ?? 0,
		}
	}

	private fromErrorPayload(payload: Record<string, unknown>): ErrorMessage {
		return {
			type: 'error',
			messageId: payload.messageId as string,
			code: (payload.code as string) ?? 'UNKNOWN',
			message: (payload.message as string) ?? 'Unknown error',
			retriable: (payload.retriable as boolean) ?? false,
		}
	}

	/**
	 * Deserialize a protobuf operation object back to a SerializedOperation.
	 */
	private deserializeOperation(op: Record<string, unknown>): SerializedOperation {
		const ts = op.timestamp as Record<string, unknown> | undefined
		const hasData = (op.hasData as boolean) ?? false
		const hasPreviousData = (op.hasPreviousData as boolean) ?? false

		// Decode data JSON from bytes (protobufjs uses base64 with { bytes: String })
		let data: Record<string, unknown> | null = null
		let atomicOps: Record<string, unknown> | undefined
		let transactionId: string | undefined
		let mutationName: string | undefined

		const dataJsonRaw = op.dataJson as string | undefined
		if ((hasData || (dataJsonRaw && dataJsonRaw.length > 0)) && dataJsonRaw) {
			try {
				const decoded = atob(dataJsonRaw)
				if (decoded.length > 0) {
					const parsed = JSON.parse(decoded) as Record<string, unknown>
					if ('__kora_atomic_ops__' in parsed) {
						atomicOps = parsed.__kora_atomic_ops__ as Record<string, unknown>
					}
					if ('__kora_tx_id__' in parsed) {
						transactionId = parsed.__kora_tx_id__ as string
					}
					if ('__kora_mutation__' in parsed) {
						mutationName = parsed.__kora_mutation__ as string
					}
					const {
						__kora_atomic_ops__: _a,
						__kora_tx_id__: _t,
						__kora_mutation__: _m,
						...rest
					} = parsed
					data = hasData && Object.keys(rest).length > 0 ? rest : null
				}
			} catch {
				// Fall back: data stays null
			}
		}

		// Check transactionId/mutationName from top-level fields too (new format)
		if (!transactionId && op.transactionId && (op.transactionId as string).length > 0) {
			transactionId = op.transactionId as string
		}
		if (!mutationName && op.mutationName && (op.mutationName as string).length > 0) {
			mutationName = op.mutationName as string
		}

		let previousData: Record<string, unknown> | null = null
		const prevJsonRaw = op.previousDataJson as string | undefined
		if (hasPreviousData && prevJsonRaw && prevJsonRaw.length > 0) {
			try {
				const decoded = atob(prevJsonRaw)
				if (decoded.length > 0) {
					previousData = JSON.parse(decoded) as Record<string, unknown>
				}
			} catch {
				// Fall back: previousData stays null
			}
		}

		return {
			id: op.id as string,
			nodeId: op.nodeId as string,
			type: op.type as SerializedOperation['type'],
			collection: op.collection as string,
			recordId: op.recordId as string,
			data,
			previousData,
			timestamp: {
				wallTime: (ts?.wallTime as number) ?? 0,
				logical: (ts?.logical as number) ?? 0,
				nodeId: (ts?.nodeId as string) ?? '',
			},
			sequenceNumber: (op.sequenceNumber as number) ?? 0,
			causalDeps: [...((op.causalDeps as string[]) ?? [])],
			schemaVersion: (op.schemaVersion as number) ?? 0,
			...(atomicOps !== undefined
				? { atomicOps: atomicOps as SerializedOperation['atomicOps'] }
				: {}),
			...(transactionId !== undefined ? { transactionId } : {}),
			...(mutationName !== undefined ? { mutationName } : {}),
		}
	}
}

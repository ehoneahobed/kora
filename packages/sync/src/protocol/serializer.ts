import { SyncError } from '@kora/core'
import type { Operation, VersionVector } from '@kora/core'
import type { SerializedOperation, SyncMessage } from './messages'
import { isSyncMessage } from './messages'

/**
 * Interface for encoding/decoding sync protocol messages.
 * Pluggable: JSON ships first, protobuf can be a drop-in later.
 */
export interface MessageSerializer {
	/** Encode a SyncMessage to a wire-format string */
	encode(message: SyncMessage): string

	/** Decode a wire-format string to a SyncMessage */
	decode(data: string): SyncMessage

	/** Convert an Operation to its wire format */
	encodeOperation(op: Operation): SerializedOperation

	/** Convert a wire-format operation back to an Operation */
	decodeOperation(serialized: SerializedOperation): Operation
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
 * JSON-based message serializer. Handles all sync protocol messages
 * and Operation serialization with full fidelity.
 */
export class JsonMessageSerializer implements MessageSerializer {
	/**
	 * Encode a SyncMessage to a JSON string.
	 */
	encode(message: SyncMessage): string {
		return JSON.stringify(message)
	}

	/**
	 * Decode a JSON string to a SyncMessage.
	 * @throws {SyncError} If the JSON is invalid or doesn't represent a valid SyncMessage
	 */
	decode(data: string): SyncMessage {
		let parsed: unknown
		try {
			parsed = JSON.parse(data)
		} catch {
			throw new SyncError('Failed to decode sync message: invalid JSON', {
				dataLength: data.length,
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

	/**
	 * Convert an Operation to its serialized wire format.
	 * The Operation's Map-based fields are preserved as-is since
	 * Operation already uses plain objects for data/previousData.
	 */
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

	/**
	 * Convert a serialized operation back to an Operation.
	 */
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

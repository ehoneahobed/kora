import type { HLCTimestamp, OperationType } from '@korajs/core'

export type WireFormat = 'json' | 'protobuf'

/**
 * Wire-format operation. Plain object (no Map) for JSON serialization.
 * Maps 1:1 with Operation, but uses Record instead of Map for version vectors.
 */
export interface SerializedOperation {
	id: string
	nodeId: string
	type: OperationType
	collection: string
	recordId: string
	data: Record<string, unknown> | null
	previousData: Record<string, unknown> | null
	timestamp: HLCTimestamp
	sequenceNumber: number
	causalDeps: string[]
	schemaVersion: number
}

/**
 * Handshake message sent by client to initiate sync.
 */
export interface HandshakeMessage {
	type: 'handshake'
	messageId: string
	nodeId: string
	/** Version vector as plain object (nodeId -> sequence number) */
	versionVector: Record<string, number>
	schemaVersion: number
	authToken?: string
	supportedWireFormats?: WireFormat[]
}

/**
 * Server response to a handshake.
 */
export interface HandshakeResponseMessage {
	type: 'handshake-response'
	messageId: string
	nodeId: string
	versionVector: Record<string, number>
	schemaVersion: number
	accepted: boolean
	rejectReason?: string
	selectedWireFormat?: WireFormat
}

/**
 * Batch of operations sent during delta exchange or streaming.
 */
export interface OperationBatchMessage {
	type: 'operation-batch'
	messageId: string
	operations: SerializedOperation[]
	/** True if this is the last batch in the delta exchange phase */
	isFinal: boolean
	/** Index of this batch (0-based) for ordering */
	batchIndex: number
}

/**
 * Acknowledgment of a received message.
 */
export interface AcknowledgmentMessage {
	type: 'acknowledgment'
	messageId: string
	acknowledgedMessageId: string
	lastSequenceNumber: number
}

/**
 * Error message from the server or client.
 */
export interface ErrorMessage {
	type: 'error'
	messageId: string
	code: string
	message: string
	retriable: boolean
}

/**
 * Union of all sync protocol messages.
 */
export type SyncMessage =
	| HandshakeMessage
	| HandshakeResponseMessage
	| OperationBatchMessage
	| AcknowledgmentMessage
	| ErrorMessage

// --- Type Guards ---

/**
 * Check if an unknown value is a valid SyncMessage.
 */
export function isSyncMessage(value: unknown): value is SyncMessage {
	if (typeof value !== 'object' || value === null) return false
	const msg = value as Record<string, unknown>
	if (typeof msg.type !== 'string' || typeof msg.messageId !== 'string') return false
	switch (msg.type) {
		case 'handshake':
			return isHandshakeMessage(value)
		case 'handshake-response':
			return isHandshakeResponseMessage(value)
		case 'operation-batch':
			return isOperationBatchMessage(value)
		case 'acknowledgment':
			return isAcknowledgmentMessage(value)
		case 'error':
			return isErrorMessage(value)
		default:
			return false
	}
}

/**
 * Check if a value is a HandshakeMessage.
 */
export function isHandshakeMessage(value: unknown): value is HandshakeMessage {
	if (typeof value !== 'object' || value === null) return false
	const msg = value as Record<string, unknown>
	return (
		msg.type === 'handshake' &&
		typeof msg.messageId === 'string' &&
		typeof msg.nodeId === 'string' &&
		typeof msg.versionVector === 'object' &&
		msg.versionVector !== null &&
		!Array.isArray(msg.versionVector) &&
		typeof msg.schemaVersion === 'number'
	)
}

/**
 * Check if a value is a HandshakeResponseMessage.
 */
export function isHandshakeResponseMessage(value: unknown): value is HandshakeResponseMessage {
	if (typeof value !== 'object' || value === null) return false
	const msg = value as Record<string, unknown>
	return (
		msg.type === 'handshake-response' &&
		typeof msg.messageId === 'string' &&
		typeof msg.nodeId === 'string' &&
		typeof msg.versionVector === 'object' &&
		msg.versionVector !== null &&
		!Array.isArray(msg.versionVector) &&
		typeof msg.schemaVersion === 'number' &&
		typeof msg.accepted === 'boolean'
	)
}

/**
 * Check if a value is an OperationBatchMessage.
 */
export function isOperationBatchMessage(value: unknown): value is OperationBatchMessage {
	if (typeof value !== 'object' || value === null) return false
	const msg = value as Record<string, unknown>
	return (
		msg.type === 'operation-batch' &&
		typeof msg.messageId === 'string' &&
		Array.isArray(msg.operations) &&
		typeof msg.isFinal === 'boolean' &&
		typeof msg.batchIndex === 'number'
	)
}

/**
 * Check if a value is an AcknowledgmentMessage.
 */
export function isAcknowledgmentMessage(value: unknown): value is AcknowledgmentMessage {
	if (typeof value !== 'object' || value === null) return false
	const msg = value as Record<string, unknown>
	return (
		msg.type === 'acknowledgment' &&
		typeof msg.messageId === 'string' &&
		typeof msg.acknowledgedMessageId === 'string' &&
		typeof msg.lastSequenceNumber === 'number'
	)
}

/**
 * Check if a value is an ErrorMessage.
 */
export function isErrorMessage(value: unknown): value is ErrorMessage {
	if (typeof value !== 'object' || value === null) return false
	const msg = value as Record<string, unknown>
	return (
		msg.type === 'error' &&
		typeof msg.messageId === 'string' &&
		typeof msg.code === 'string' &&
		typeof msg.message === 'string' &&
		typeof msg.retriable === 'boolean'
	)
}

import type { AtomicOp, HLCTimestamp, OperationType } from '@korajs/core'

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
	/** Atomic operation intents, present only when atomic ops were used. */
	atomicOps?: Record<string, AtomicOp>
	/** Groups this operation with others in an atomic transaction. */
	transactionId?: string
	/** Human-readable name for the mutation group. For DevTools display. */
	mutationName?: string
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
	/** Per-collection sync scope filters. Limits which records are synced to this client. */
	syncScope?: Record<string, Record<string, unknown>>
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
	/** The server-accepted per-collection sync scope. Confirms what data will be synced. */
	acceptedScope?: Record<string, Record<string, unknown>>
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
 * Awareness state for a single client (cursor position, user info).
 * Wire-format representation for JSON transport.
 * Ephemeral -- not persisted, only shared with connected peers.
 */
export interface AwarenessStateWire {
	user: {
		name: string
		color: string
		avatar?: string
	}
	cursor?: {
		collection: string
		recordId: string
		field: string
		anchor: number
		head: number
	}
}

/**
 * Awareness update message. Carries ephemeral presence data (cursors, user info).
 * Processed separately from operation sync -- never persisted.
 */
export interface AwarenessUpdateMessage {
	type: 'awareness-update'
	messageId: string
	/** Client ID of the sender */
	clientId: number
	/** Map of clientId -> state (null means removal) */
	states: Record<string, AwarenessStateWire | null>
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
	| AwarenessUpdateMessage

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
		case 'awareness-update':
			return isAwarenessUpdateMessage(value)
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

/**
 * Check if a value is an AwarenessUpdateMessage.
 */
export function isAwarenessUpdateMessage(value: unknown): value is AwarenessUpdateMessage {
	if (typeof value !== 'object' || value === null) return false
	const msg = value as Record<string, unknown>
	return (
		msg.type === 'awareness-update' &&
		typeof msg.messageId === 'string' &&
		typeof msg.clientId === 'number' &&
		typeof msg.states === 'object' &&
		msg.states !== null &&
		!Array.isArray(msg.states)
	)
}

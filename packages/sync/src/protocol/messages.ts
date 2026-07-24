import type { AtomicOp, HLCTimestamp, OperationType } from '@korajs/core'
import type { SyncQuerySubset } from '../scopes/query-subset'

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
	/** Base64url-encoded delta cursor for resuming paginated initial sync */
	deltaCursor?: string
	/** Live query filters that further narrow synced data within auth/schema scope */
	syncQueries?: SyncQuerySubset[]
	/**
	 * The client's persisted delivery watermark: the highest server delivery sequence
	 * up to which it has contiguously applied every in-scope operation. Omitted (or 0)
	 * on first sync. When present, the server resumes the gap-free server->client
	 * stream from just after it, superseding the version-vector delta and the resume
	 * cursor for the server->client direction. Optional, so old servers ignore it.
	 */
	lastDeliverySequence?: number
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
	/** Inclusive minimum schema version the server accepts (present when rejected for schema mismatch). */
	supportedSchemaMin?: number
	/** Inclusive maximum schema version the server accepts (present when rejected for schema mismatch). */
	supportedSchemaMax?: number
	selectedWireFormat?: WireFormat
	/** The server-accepted per-collection sync scope. Confirms what data will be synced. */
	acceptedScope?: Record<string, Record<string, unknown>>
	/** Server wall-clock time (ms since epoch) at response creation. Lets clients measure their own clock skew. */
	serverTime?: number
	/**
	 * Whether the server persists blob bytes centrally. When true, a client
	 * automatically uploads the bytes behind its `blob` fields so they remain
	 * available to other devices even after the authoring device goes offline.
	 */
	blobStorageEnabled?: boolean
	/**
	 * The server's highest delivery sequence at handshake time. A client whose
	 * persisted delivery watermark exceeds this (the server's operation log was rolled
	 * back, for example by a backup restore) resets its watermark to 0 so it resyncs
	 * from the beginning instead of sitting above a frontier that no longer exists.
	 */
	serverMaxDeliverySequence?: number
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
	/** Base64url-encoded cursor marking the last operation in this batch */
	cursor?: string
	/** Total batches in this delta exchange (for progress reporting) */
	totalBatches?: number
	/**
	 * Delivery-watermark chaining (server->client). `baseDeliverySequence` is the
	 * delivery sequence the client must already hold for this batch to apply in order
	 * (it equals the previous batch's `maxDeliverySequence`, or the client's reported
	 * watermark for the first batch after a handshake). `maxDeliverySequence` is the
	 * highest delivery sequence carried by this batch. The client applies the batch
	 * only when its watermark equals `baseDeliverySequence`, then advances the
	 * watermark to `maxDeliverySequence`. A dropped batch breaks the chain and stalls
	 * the watermark, so the reconnect resend recovers it. Present only on batches the
	 * server sends as part of the delivery stream; absent on legacy version-vector
	 * batches.
	 */
	baseDeliverySequence?: number
	maxDeliverySequence?: number
}

/**
 * Acknowledgment of a received message.
 */
export interface AcknowledgmentMessage {
	type: 'acknowledgment'
	messageId: string
	acknowledgedMessageId: string
	lastSequenceNumber: number
	/**
	 * The acknowledged batch's `maxDeliverySequence`, echoed so the server can advance
	 * this client's durable delivery watermark. Present only when acking a delivery-
	 * stream batch. `lastSequenceNumber` stays for existing per-node behavior.
	 */
	deliverySequence?: number
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
 * Server-to-client rejection of ONE specific operation the client submitted.
 *
 * Unlike {@link ErrorMessage}, which is connection-level, this is tied to an
 * `operationId` so the client can divert exactly that operation out of its
 * pending outbound queue and into a durable rejected-operations store — kept and
 * explainable rather than silently retried forever or lost on the batch ack. The
 * operation never entered the server's authoritative log, so no other replica
 * ever sees it; the submitter is told so its optimistic local copy can be
 * reconciled (rolled back or resubmitted) by the app.
 */
export interface OperationRejectedMessage {
	type: 'operation-rejected'
	messageId: string
	/** Content-addressed id of the rejected operation. */
	operationId: string
	/** Collection the rejected operation targeted (for app routing / display). */
	collection: string
	/** Record the rejected operation targeted. */
	recordId: string
	/** Stable, machine-readable reason code. */
	code: string
	/** Human-readable explanation. */
	message: string
	/** Whether resubmitting the identical operation may later succeed. */
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
 * Incremental Yjs update for a richtext field. Ephemeral side channel for large documents.
 * JSON transport only; not persisted on the server operation log.
 */
export interface YjsDocUpdateMessage {
	type: 'yjs-doc-update'
	messageId: string
	collection: string
	recordId: string
	field: string
	/** Base64-encoded Yjs update binary */
	update: string
}

/**
 * Request for a single blob chunk by content hash. Ephemeral side channel for
 * out-of-band blob transfer over the sync connection; never persisted in the
 * operation log (durable state is the BlobRef inside a record's fields).
 *
 * Possession of a chunk hash is itself the capability to request it: hashes are
 * only learned from BlobRefs inside records the peer already received through
 * its (scope-filtered) sync, and SHA-256 preimage resistance makes guessing a
 * hash infeasible. The server therefore relays chunk requests among peers
 * without a separate ACL.
 */
export interface BlobChunkRequestMessage {
	type: 'blob-chunk-request'
	messageId: string
	/** Correlates the response to this request. */
	requestId: string
	/** SHA-256 hash of the requested chunk. */
	hash: string
}

/**
 * Response to a {@link BlobChunkRequestMessage}. Carries the chunk bytes, or
 * null when the responder does not hold that hash.
 */
export interface BlobChunkResponseMessage {
	type: 'blob-chunk-response'
	messageId: string
	/** Echoes the request's `requestId` for correlation. */
	requestId: string
	/** Base64-encoded chunk bytes, or null when the responder does not hold the hash. */
	bytes: string | null
}

/**
 * Unsolicited upload of a blob chunk (or a blob manifest) from a client to the
 * server, so the server can persist it centrally and serve it to other devices
 * even after the authoring device disconnects. Content-addressed: the receiver
 * verifies the bytes hash to `hash`.
 */
export interface BlobChunkPushMessage {
	type: 'blob-chunk-push'
	messageId: string
	/** SHA-256 hash of the pushed bytes (a chunk hash or a manifest hash). */
	hash: string
	/** Base64-encoded bytes. */
	bytes: string
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
	| OperationRejectedMessage
	| AwarenessUpdateMessage
	| YjsDocUpdateMessage
	| BlobChunkRequestMessage
	| BlobChunkResponseMessage
	| BlobChunkPushMessage

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
		case 'operation-rejected':
			return isOperationRejectedMessage(value)
		case 'awareness-update':
			return isAwarenessUpdateMessage(value)
		case 'yjs-doc-update':
			return isYjsDocUpdateMessage(value)
		case 'blob-chunk-request':
			return isBlobChunkRequestMessage(value)
		case 'blob-chunk-response':
			return isBlobChunkResponseMessage(value)
		case 'blob-chunk-push':
			return isBlobChunkPushMessage(value)
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
 * Check if a value is an OperationRejectedMessage.
 */
export function isOperationRejectedMessage(value: unknown): value is OperationRejectedMessage {
	if (typeof value !== 'object' || value === null) return false
	const msg = value as Record<string, unknown>
	return (
		msg.type === 'operation-rejected' &&
		typeof msg.messageId === 'string' &&
		typeof msg.operationId === 'string' &&
		typeof msg.collection === 'string' &&
		typeof msg.recordId === 'string' &&
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

/**
 * Check if a value is a YjsDocUpdateMessage.
 */
export function isYjsDocUpdateMessage(value: unknown): value is YjsDocUpdateMessage {
	if (typeof value !== 'object' || value === null) return false
	const msg = value as Record<string, unknown>
	return (
		msg.type === 'yjs-doc-update' &&
		typeof msg.messageId === 'string' &&
		typeof msg.collection === 'string' &&
		typeof msg.recordId === 'string' &&
		typeof msg.field === 'string' &&
		typeof msg.update === 'string'
	)
}

/**
 * Check if a value is a BlobChunkRequestMessage.
 */
export function isBlobChunkRequestMessage(value: unknown): value is BlobChunkRequestMessage {
	if (typeof value !== 'object' || value === null) return false
	const msg = value as Record<string, unknown>
	return (
		msg.type === 'blob-chunk-request' &&
		typeof msg.messageId === 'string' &&
		typeof msg.requestId === 'string' &&
		typeof msg.hash === 'string'
	)
}

/**
 * Check if a value is a BlobChunkResponseMessage.
 */
export function isBlobChunkResponseMessage(value: unknown): value is BlobChunkResponseMessage {
	if (typeof value !== 'object' || value === null) return false
	const msg = value as Record<string, unknown>
	return (
		msg.type === 'blob-chunk-response' &&
		typeof msg.messageId === 'string' &&
		typeof msg.requestId === 'string' &&
		(typeof msg.bytes === 'string' || msg.bytes === null)
	)
}

/**
 * Check if a value is a BlobChunkPushMessage.
 */
export function isBlobChunkPushMessage(value: unknown): value is BlobChunkPushMessage {
	if (typeof value !== 'object' || value === null) return false
	const msg = value as Record<string, unknown>
	return (
		msg.type === 'blob-chunk-push' &&
		typeof msg.messageId === 'string' &&
		typeof msg.hash === 'string' &&
		typeof msg.bytes === 'string'
	)
}

import type { WrappedKeyRecord } from './key-record'

/**
 * Key-distribution side channel of the sync protocol (ENC-1, D4b). Accepted only after
 * a successful handshake. The server answers for the session's own principal: a
 * message never names a user, so no session can read or write another user's record.
 * JSON on every wire format (the records are small and rare).
 */

/** Client -> server: fetch the session principal's record of one keyring. */
export interface EncryptionKeyRequestMessage {
	type: 'encryption-key-request'
	messageId: string
	/** Correlates the response. */
	requestId: string
	keyring: string
}

/** Client -> server: write the record with compare-and-set on its revision. */
export interface EncryptionKeyPutMessage {
	type: 'encryption-key-put'
	messageId: string
	requestId: string
	keyring: string
	/** The full new record; its revision must be `expectedRevision + 1`. */
	record: WrappedKeyRecord
	/** The revision being replaced (0: create). */
	expectedRevision: number
}

/** Status of a key-service response. */
export type EncryptionKeyResponseStatus =
	| 'ok'
	| 'conflict'
	| 'forbidden'
	| 'invalid'
	| 'unsupported'
	| 'throttled'

/**
 * Server -> client: the answer to a request or put (with `requestId`), or an
 * unsolicited push of a record another device of the same principal wrote (without).
 */
export interface EncryptionKeyResponseMessage {
	type: 'encryption-key-response'
	messageId: string
	requestId?: string
	keyring: string
	status: EncryptionKeyResponseStatus
	/** The current record (null when none exists, or on refusal). */
	record: WrappedKeyRecord | null
	/** Human-readable reason for a refusal. */
	message?: string
	/**
	 * With `record: null`: key ids the server's stored operations of this owner are
	 * encrypted with (a sample, RT-104). Non-empty means encrypted history exists, so
	 * the record was lost: a new device waits for one that holds the ring.
	 */
	knownKeyIds?: string[]
}

/** Every key-distribution message. */
export type EncryptionKeyMessage =
	| EncryptionKeyRequestMessage
	| EncryptionKeyPutMessage
	| EncryptionKeyResponseMessage

const STATUSES: ReadonlySet<string> = new Set([
	'ok',
	'conflict',
	'forbidden',
	'invalid',
	'unsupported',
	'throttled',
])

/** Whether a message type belongs to the key-distribution channel. */
export function isEncryptionKeyMessageType(type: unknown): boolean {
	return (
		type === 'encryption-key-request' ||
		type === 'encryption-key-put' ||
		type === 'encryption-key-response'
	)
}

/**
 * Structural guard of the key-distribution messages (records are validated in full
 * by the receiver).
 */
export function isEncryptionKeyMessage(value: unknown): value is EncryptionKeyMessage {
	if (typeof value !== 'object' || value === null) return false
	const msg = value as Record<string, unknown>
	if (typeof msg.messageId !== 'string' || typeof msg.keyring !== 'string') return false
	switch (msg.type) {
		case 'encryption-key-request':
			return typeof msg.requestId === 'string'
		case 'encryption-key-put':
			return (
				typeof msg.requestId === 'string' &&
				typeof msg.record === 'object' &&
				msg.record !== null &&
				typeof msg.expectedRevision === 'number'
			)
		case 'encryption-key-response':
			return (
				(msg.requestId === undefined || typeof msg.requestId === 'string') &&
				typeof msg.status === 'string' &&
				STATUSES.has(msg.status) &&
				(msg.knownKeyIds === undefined ||
					(Array.isArray(msg.knownKeyIds) &&
						msg.knownKeyIds.every((keyId) => typeof keyId === 'string'))) &&
				(msg.record === null || (typeof msg.record === 'object' && msg.record !== undefined))
			)
		default:
			return false
	}
}

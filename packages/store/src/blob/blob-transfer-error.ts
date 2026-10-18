import { KoraError } from '@korajs/core'

/** Why a blob chunk request ended without bytes. */
export const BLOB_TRANSFER_ERROR_CODES = [
	// No answer (or only "throttled" answers) within the request's deadline.
	'BLOB_CHUNK_TIMEOUT',
	// Answered: nobody reachable holds the chunk (or may give it to this device).
	'BLOB_CHUNK_UNAVAILABLE',
	// The provider was closed (the app closed or disconnected) while the request waited.
	'BLOB_CHUNK_CANCELLED',
] as const
export type BlobTransferErrorCode = (typeof BLOB_TRANSFER_ERROR_CODES)[number]

/**
 * Why the last attempt of a blob chunk request did not produce bytes:
 * `not-connected` (the last try could not be sent; with `attempts` 0 the request never
 * left the device), `timeout` (sent, no answer),
 * `throttled` (the server asked to retry later), `not-held` (answered: nobody holds
 * it), `closed` (the provider was closed).
 */
export type BlobChunkFailureReason =
	| 'not-connected'
	| 'timeout'
	| 'throttled'
	| 'not-held'
	| 'closed'

/**
 * A blob chunk could not be obtained. The transfer is resumable: chunks already
 * received are kept, so pulling the blob again later fetches only what is missing.
 *
 * `code` tells "lost" from "refused": `BLOB_CHUNK_TIMEOUT` (nothing answered in time,
 * after retries), `BLOB_CHUNK_UNAVAILABLE` (answered: no reachable peer or server
 * holds it), `BLOB_CHUNK_CANCELLED` (the app closed while it waited).
 */
export class BlobTransferError extends KoraError {
	constructor(
		message: string,
		code: BlobTransferErrorCode,
		public readonly hash: string,
		/** Requests actually sent (0 when none could be); tries made offline are not counted. */
		public readonly attempts: number,
		public readonly lastReason: BlobChunkFailureReason,
	) {
		super(message, code, { hash, attempts, lastReason })
		this.name = 'BlobTransferError'
	}
}

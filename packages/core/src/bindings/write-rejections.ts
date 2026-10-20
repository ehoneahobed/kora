import type { KoraEventEmitter } from '../events/events'

/**
 * A permanent server refusal of one operation this device wrote, normalized from the
 * events that report one (`sync:operation-rejected` with `retriable: false`, and
 * `sync:scope-retracted` with quarantined operations).
 */
export interface WriteRejectionEvent {
	operationId: string
	collection: string
	recordId: string
	code: string
	message: string
	/** Whether the device already undid the operation locally (see {@link isRevertingRejection}). */
	reverted: boolean
}

/**
 * Rejection codes the device records WITHOUT undoing the write: the operation was not
 * judged on its content (a node-id or sequence-number problem), or the client refused to
 * upload it against the scope it had then. The local value stays as written. Mirrors
 * `NON_TERMINAL_REJECTION_CODES` in `@korajs/store` / `@korajs/sync`.
 */
const KEPT_LOCALLY_CODES: ReadonlySet<string> = new Set([
	'SEQUENCE_CONFLICT',
	'NODE_ID_MISMATCH',
	'OUT_OF_UPLINK_SCOPE',
])

/** Message recorded for a write refused because its record left the sync scope. */
const SCOPE_RETRACTED_MESSAGE = 'Authorization changed before this operation could be uploaded.'

/**
 * Whether a permanent rejection with this code is undone on the device: every terminal
 * refusal is (the record is re-folded without the operation, so the local value goes
 * back to what the server holds), except the codes that are only recorded.
 */
export function isRevertingRejection(code: string): boolean {
	return !KEPT_LOCALLY_CODES.has(code)
}

/**
 * Listen for permanent refusals of this device's operations. A retriable rejection is
 * not reported: the operation stays queued and is uploaded again.
 *
 * @returns An unsubscribe function
 */
export function subscribeWriteRejections(
	events: KoraEventEmitter,
	listener: (rejection: WriteRejectionEvent) => void,
): () => void {
	const offRejected = events.on('sync:operation-rejected', (event) => {
		if (event.retriable) return
		listener({
			operationId: event.operationId,
			collection: event.collection,
			recordId: event.recordId,
			code: event.code,
			message: event.message,
			reverted: isRevertingRejection(event.code),
		})
	})
	// A record leaving the sync scope takes its unsent writes with it: they are refused
	// for good (SCOPE_RETRACTED) and undone, reported through this event only.
	const offRetracted = events.on('sync:scope-retracted', (event) => {
		for (const operationId of event.quarantinedOperationIds) {
			listener({
				operationId,
				collection: event.collection,
				recordId: event.recordId,
				code: 'SCOPE_RETRACTED',
				message: SCOPE_RETRACTED_MESSAGE,
				reverted: true,
			})
		}
	})
	return () => {
		offRejected()
		offRetracted()
	}
}

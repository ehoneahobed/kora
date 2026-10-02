import type { Operation } from '@korajs/core'
import { KoraError } from '@korajs/core'
import {
	SERVER_MAX_TIMESTAMP_FUTURE_MS,
	isOperationTimestampValid,
} from '../session/operation-validation'

/** Rejection code for an operation stamped too far ahead of server time (SYNC-7). */
export const INVALID_TIMESTAMP_CODE = 'INVALID_TIMESTAMP'
/** Rejection code for a sequence number that is not a safe positive integer (SRV-4). */
export const INVALID_SEQUENCE_NUMBER_CODE = 'INVALID_SEQUENCE_NUMBER'

/** Result of {@link validateIngestedOperation}. */
export type IngestValidationResult =
	| { valid: true }
	| {
			valid: false
			code: typeof INVALID_TIMESTAMP_CODE | typeof INVALID_SEQUENCE_NUMBER_CODE
			message: string
	  }

/**
 * True when `sequenceNumber` can identify a node's write: a positive integer no larger
 * than `Number.MAX_SAFE_INTEGER` (beyond it, two numbers collapse into one double).
 */
export function isValidSequenceNumber(sequenceNumber: unknown): sequenceNumber is number {
	return (
		typeof sequenceNumber === 'number' &&
		Number.isSafeInteger(sequenceNumber) &&
		sequenceNumber >= 1
	)
}

/**
 * The checks every path that brings an operation INTO the server's log runs (sync
 * ingest, route `kora.apply`, `applyLocalOperation`, backup import): the HLC
 * timestamp is well formed and not more than {@link SERVER_MAX_TIMESTAMP_FUTURE_MS}
 * ahead of the server's clock, and the sequence number is a safe positive integer.
 *
 * A far-future operation that got in would make every receiver's HLC jump (or refuse
 * it), and every later local edit would lose to it until real time caught up (SYNC-7),
 * so it is stopped at the server, where time is trusted.
 *
 * @param op - The operation entering the log
 * @param now - The server's current time in ms (injectable for tests)
 */
export function validateIngestedOperation(
	op: Operation,
	now: number = Date.now(),
): IngestValidationResult {
	if (!isValidSequenceNumber(op.sequenceNumber)) {
		return {
			valid: false,
			code: INVALID_SEQUENCE_NUMBER_CODE,
			message: `Operation "${op.id}" has sequence number ${String(op.sequenceNumber)}; sequence numbers are positive integers no larger than ${String(Number.MAX_SAFE_INTEGER)}.`,
		}
	}
	if (
		typeof op.timestamp !== 'object' ||
		op.timestamp === null ||
		!isOperationTimestampValid(op, now)
	) {
		return {
			valid: false,
			code: INVALID_TIMESTAMP_CODE,
			message: `Operation "${op.id}" has an invalid timestamp or one more than ${String(SERVER_MAX_TIMESTAMP_FUTURE_MS)} ms ahead of server time. Check the clock of the device or server that wrote it.`,
		}
	}
	return { valid: true }
}

/**
 * Thrown by a backup import whose operations fail {@link validateIngestedOperation}.
 * Nothing is restored: a backup is all-or-nothing, so a far-future (or malformed)
 * operation is reported instead of silently dropped or silently restored.
 */
export class BackupValidationError extends KoraError {
	constructor(
		readonly invalidOperations: Array<{ operationId: string; code: string }>,
		readonly totalOperations: number,
	) {
		super(
			`Backup rejected: ${String(invalidOperations.length)} of ${String(totalOperations)} operations failed ingest validation (first: "${invalidOperations[0]?.operationId ?? ''}", ${invalidOperations[0]?.code ?? ''}). A far-future timestamp usually means the exporting server's clock was wrong; fix the clock and re-export, or repair the operations before restoring.`,
			'BACKUP_INVALID_OPERATION',
			{
				invalidCount: invalidOperations.length,
				totalOperations,
				sample: invalidOperations.slice(0, 10),
			},
		)
		this.name = 'BackupValidationError'
	}
}

/**
 * Validate every operation of a backup against server time before anything is
 * restored. Throws {@link BackupValidationError} listing the offenders.
 */
export function assertBackupOperationsIngestible(
	operations: Operation[],
	now: number = Date.now(),
): void {
	const invalid: Array<{ operationId: string; code: string }> = []
	for (const op of operations) {
		const result = validateIngestedOperation(op, now)
		if (!result.valid) invalid.push({ operationId: String(op.id), code: result.code })
	}
	if (invalid.length > 0) throw new BackupValidationError(invalid, operations.length)
}

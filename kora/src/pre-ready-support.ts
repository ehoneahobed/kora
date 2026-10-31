import { KoraError } from '@korajs/core/lite'
import type { JournaledWriteKind } from './write-journal'

/**
 * Helpers of the pre-ready write queue that only code loaded after first paint uses (the
 * journal and recovery modules): time limits for journal calls, record keys, and the checks
 * that decide whether a write can be saved. Kept out of `pre-ready-writes`, which the first
 * paint downloads (first-visit parity, K3).
 */

/** A timeout raised by {@link withTimeout}. */
class JournalTimeoutError extends KoraError {
	constructor(what: string, ms: number) {
		super(`Could not ${what} within ${ms} ms.`, 'JOURNAL_TIMEOUT', {
			fix: 'The write stays in memory and is applied when the store opens.',
		})
		this.name = 'JournalTimeoutError'
	}
}

export function isTimeout(error: unknown): boolean {
	return error instanceof JournalTimeoutError
}

/** Reject if `work` does not settle within `ms`; the timer never outlives the work. */
export function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new JournalTimeoutError(what, ms)), ms)
		work.then(
			(value) => {
				clearTimeout(timer)
				resolve(value)
			},
			(error: unknown) => {
				clearTimeout(timer)
				reject(error)
			},
		)
	})
}

/** Bound a journal call: past the queue's limit the journal is treated as not answering. */
export function bounded<T>(
	q: { journalTimeout: number },
	work: Promise<T>,
	what: string,
): Promise<T> {
	return withTimeout(work, q.journalTimeout, what)
}

/** The record an update or delete addresses (its first argument). */
export function targetRecordId(kind: JournaledWriteKind, args: unknown[]): string | undefined {
	if (kind !== 'update' && kind !== 'delete') return undefined
	return typeof args[0] === 'string' ? args[0] : undefined
}

/** Key of a record in a set of unresolved records. */
export function recordKey(collection: string, recordId: string): string {
	return `${collection}\u0000${recordId}`
}

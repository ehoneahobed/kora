/**
 * Outcome of applying a single operation to materialized storage (local or remote).
 */
export const APPLY_RESULTS = ['applied', 'duplicate', 'skipped', 'rejected', 'deferred'] as const

export type ApplyResult = (typeof APPLY_RESULTS)[number]

/**
 * Structured failure metadata when apply returns `skipped`, `rejected`, or `deferred`.
 */
export interface ApplyFailureReason {
	code: string
	message: string
	retriable: boolean
}

/** Well-known apply failure codes for DevTools and `sync:apply-failed` events. */
export const APPLY_FAILURE_CODES = {
	APPLY_FAILED: 'APPLY_FAILED',
	APPLY_SKIPPED: 'APPLY_SKIPPED',
	APPLY_REJECTED: 'APPLY_REJECTED',
	APPLY_DEFERRED: 'APPLY_DEFERRED',
	CLOCK_DRIFT: 'CLOCK_DRIFT',
	REFERENTIAL_INTEGRITY: 'REFERENTIAL_INTEGRITY',
	SCHEMA_MISMATCH: 'SCHEMA_MISMATCH',
} as const

/**
 * Returns true when the apply outcome should surface as a failure to the developer.
 */
export function isApplyFailure(result: ApplyResult): boolean {
	return result === 'skipped' || result === 'rejected' || result === 'deferred'
}

/**
 * Default failure metadata when the store does not attach a specific reason.
 */
export function defaultApplyFailureReason(
	result: Exclude<ApplyResult, 'applied' | 'duplicate'>,
	overrides?: Partial<ApplyFailureReason>,
): ApplyFailureReason {
	const base: ApplyFailureReason =
		result === 'deferred'
			? {
					code: APPLY_FAILURE_CODES.APPLY_DEFERRED,
					message: 'Operation apply was deferred.',
					retriable: true,
				}
			: result === 'rejected'
				? {
						code: APPLY_FAILURE_CODES.APPLY_REJECTED,
						message: 'Operation apply was rejected.',
						retriable: false,
					}
				: {
						code: APPLY_FAILURE_CODES.APPLY_SKIPPED,
						message: 'Operation apply was skipped.',
						retriable: false,
					}

	return { ...base, ...overrides }
}

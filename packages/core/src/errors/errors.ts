import { getKoraErrorFix } from './error-fixes'

/**
 * Base error class for all Kora errors.
 * Every error includes a machine-readable code and optional context for debugging.
 */
export class KoraError extends Error {
	constructor(
		message: string,
		public readonly code: string,
		public readonly context?: Record<string, unknown>,
	) {
		super(message)
		this.name = 'KoraError'
	}

	/**
	 * Actionable hint for resolving this error (from registry or error context).
	 */
	get fix(): string | undefined {
		const fromContext = this.context?.fix
		if (typeof fromContext === 'string' && fromContext.length > 0) {
			return fromContext
		}
		return getKoraErrorFix(this.code)
	}
}

/**
 * Thrown when schema validation fails during defineSchema() or at app initialization.
 */
export class SchemaValidationError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'SCHEMA_VALIDATION', context)
		this.name = 'SchemaValidationError'
	}
}

/**
 * Thrown when an operation is invalid or cannot be created.
 */
export class OperationError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'OPERATION_ERROR', context)
		this.name = 'OperationError'
	}
}

/**
 * Thrown when a merge conflict cannot be automatically resolved.
 */
export class MergeConflictError extends KoraError {
	constructor(
		public readonly operationA: { id: string; collection: string },
		public readonly operationB: { id: string; collection: string },
		public readonly field: string,
	) {
		super(
			`Merge conflict on field "${field}" in collection "${operationA.collection}"`,
			'MERGE_CONFLICT',
			{ operationA: operationA.id, operationB: operationB.id, field },
		)
		this.name = 'MergeConflictError'
	}
}

/**
 * Thrown when a sync error occurs.
 */
export class SyncError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'SYNC_ERROR', context)
		this.name = 'SyncError'
	}
}

/**
 * Thrown when a storage operation fails.
 */
export class StorageError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'STORAGE_ERROR', context)
		this.name = 'StorageError'
	}
}

/**
 * Thrown when collection/query APIs are used before {@link KoraApp.ready} resolves.
 */
export class AppNotReadyError extends KoraError {
	constructor(detail: string) {
		super(detail, 'APP_NOT_READY', {
			fix: 'Await app.ready, or wrap your UI in <KoraProvider app={app}> before calling useQuery().',
		})
		this.name = 'AppNotReadyError'
	}
}

/**
 * Thrown when the HLC detects excessive clock drift.
 * Drift > 60s: warning. Drift > 5min: this error is thrown, refusing to generate timestamps.
 */
export class RemoteClockDriftError extends KoraError {
	constructor(
		public readonly remoteWallTime: number,
		public readonly localReferenceTime: number,
	) {
		const aheadSeconds = Math.round((remoteWallTime - localReferenceTime) / 1000)
		super(
			`Rejected remote timestamp ${aheadSeconds}s ahead of local reference time. The sending device's clock is set too far in the future.`,
			'REMOTE_CLOCK_DRIFT',
			{ remoteWallTime, localReferenceTime, aheadSeconds },
		)
		this.name = 'RemoteClockDriftError'
	}
}

/**
 * Thrown when an HLC timestamp has structurally invalid fields: non-integer or
 * negative wallTime/logical, or a logical counter beyond the serializable cap.
 * Rejected BEFORE any clock state changes, so a malformed remote timestamp can
 * never corrupt a replica's clock or break the lexicographic ordering of the
 * serialized form.
 */
export class InvalidTimestampError extends KoraError {
	constructor(
		message: string,
		public readonly wallTime: number,
		public readonly logical: number,
	) {
		super(message, 'INVALID_TIMESTAMP_FIELDS', { wallTime, logical })
		this.name = 'InvalidTimestampError'
	}
}

export class ClockDriftError extends KoraError {
	constructor(
		public readonly currentHlcTime: number,
		public readonly physicalTime: number,
	) {
		const driftSeconds = Math.round((currentHlcTime - physicalTime) / 1000)
		super(
			`Clock drift of ${driftSeconds}s detected. Physical time is behind HLC by more than 5 minutes. This indicates a severe clock issue.`,
			'CLOCK_DRIFT',
			{ currentHlcTime, physicalTime, driftSeconds },
		)
		this.name = 'ClockDriftError'
	}
}

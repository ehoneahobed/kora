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
 * Thrown when the HLC detects excessive clock drift.
 * Drift > 60s: warning. Drift > 5min: this error is thrown, refusing to generate timestamps.
 */
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

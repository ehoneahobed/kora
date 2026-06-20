import type { MergeTrace, Operation } from '@korajs/core'

/**
 * A merge or constraint decision persisted for enterprise audit export.
 */
export interface PersistedAuditTrace {
	/** Unique row id (UUID v7). */
	id: string
	/** Wall-clock time when the trace was recorded (epoch ms). */
	recordedAt: number
	/** Source event type from the Kora event bus. */
	eventType: 'merge:completed' | 'merge:conflict' | 'constraint:violated'
	/** Constraint name when {@link eventType} is `constraint:violated`. */
	constraint?: string
	/** Full merge trace including conflicting operations and resolution details. */
	trace: MergeTrace
}

/**
 * Manifest embedded in audit export files.
 */
export interface AuditExportManifest {
	/** Audit export format version */
	version: 1
	/** When the export was created (epoch ms) */
	exportedAt: number
	/** Node ID of the originating device */
	nodeId: string
	/** Schema version at export time */
	schemaVersion: number
	/** Number of operations included */
	operationCount: number
	/** Number of merge traces included */
	mergeTraceCount: number
	/** SHA-256 hex checksum of content sections */
	checksum: string
}

/**
 * Decoded audit export payload.
 */
export interface AuditExportPayload {
	manifest: AuditExportManifest
	operations: Operation[]
	mergeTraces: PersistedAuditTrace[]
}

/**
 * Progress reported during audit export.
 */
export interface AuditExportProgress {
	phase: 'reading' | 'writing' | 'verifying'
	/** 0-1 progress ratio */
	progress: number
	message: string
}

/**
 * Options for {@link exportAudit}.
 */
export interface AuditExportOptions {
	/** Subset of collections for operations and traces. All if omitted. */
	collections?: string[]
	/** Include only traces recorded at or after this timestamp (epoch ms). */
	since?: number
	/** Include only traces recorded at or before this timestamp (epoch ms). */
	until?: number
	/** Progress callback */
	onProgress?: (progress: AuditExportProgress) => void
}

/**
 * Query filters for reading persisted audit traces.
 */
export interface AuditTraceQuery {
	collections?: string[]
	since?: number
	until?: number
}

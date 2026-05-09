/**
 * Manifest embedded in every backup file.
 */
export interface BackupManifest {
	/** Backup format version */
	version: 1
	/** When the backup was created (epoch ms) */
	createdAt: number
	/** Node ID of the originating device */
	nodeId: string
	/** Schema version at backup time */
	schemaVersion: number
	/** Total number of operations in the backup */
	operationCount: number
	/** Collection names included in the backup */
	collections: string[]
	/** Whether materialized records are included */
	includesRecords: boolean
	/** SHA-256 hex checksum of all content sections */
	checksum: string
}

/**
 * Progress reported during backup/restore operations.
 */
export interface BackupProgress {
	phase: 'reading' | 'writing' | 'verifying' | 'restoring'
	/** 0-1 progress ratio */
	progress: number
	message: string
}

/**
 * Result of a restore operation.
 */
export interface RestoreResult {
	/** Number of operations restored */
	operationsRestored: number
	/** Number of records restored */
	recordsRestored: number
	/** Whether the restore completed successfully */
	success: boolean
	/** Error message if failed */
	error?: string
	/** Duration in ms */
	duration: number
}

/**
 * Options for exporting a backup.
 */
export interface BackupOptions {
	/** Include materialized record snapshots (default: true) */
	includeRecords?: boolean
	/** Subset of collections to backup. All if omitted. */
	collections?: string[]
	/** Progress callback */
	onProgress?: (progress: BackupProgress) => void
}

/**
 * Options for restoring from a backup.
 */
export interface RestoreOptions {
	/** Subset of collections to restore. All if omitted. */
	collections?: string[]
	/** Progress callback */
	onProgress?: (progress: BackupProgress) => void
	/**
	 * If true, merge operations with existing data (replay through applyRemoteOperation).
	 * If false, clear and replace all data (default: false).
	 */
	merge?: boolean
}

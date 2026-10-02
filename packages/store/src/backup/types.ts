/**
 * Manifest embedded in every backup file.
 */
export interface BackupManifest {
	/** Backup format version (2 since STORE-5; version 1 files need `convertBackupV1`) */
	version: number
	/** When the backup was created (epoch ms) */
	createdAt: number
	/**
	 * Node ID of the originating device. Informational only: a restore never copies a
	 * device identity into the importing database.
	 */
	nodeId: string
	/** Schema version at backup time */
	schemaVersion: number
	/** Total number of operations in the backup */
	operationCount: number
	/** Collection names included in the backup */
	collections: string[]
	/** Whether materialized records are included */
	includesRecords: boolean
	/** Whether the records include deleted rows (tombstones). False for converted v1 files. */
	includesTombstones?: boolean
	/** Set on a file produced by `convertBackupV1`. */
	convertedFrom?: number
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
	/** Error code if failed (`BACKUP_FORMAT_OUTDATED`, `BACKUP_CHECKSUM_MISMATCH`, ...) */
	errorCode?: string
	/**
	 * Replace mode: this device's own writes the sync server had not acknowledged,
	 * re-applied on top of the restored data (see `RestoreOptions.keepUnsyncedWrites`).
	 */
	unsyncedWritesKept?: number
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
	 * If true, merge the backup into the existing data: every operation is applied like
	 * one received from sync (deduplicated by id, merged per field), the version vector
	 * advances by MAX, and nothing of the exporting device's identity or sync state is
	 * imported. If false (default), replace the local data with the backup's.
	 */
	merge?: boolean
	/**
	 * Replace mode only: keep this device's own writes that the sync server has not
	 * acknowledged, re-applied on top of the backup, so a restore never discards writes
	 * that exist nowhere else. Writes of a node the server has accepted are always kept
	 * (they are in flight). Default: true for `store.importBackup`; `app.importBackup`
	 * defaults it to whether sync is configured, so a local-only app gets an exact
	 * replace.
	 */
	keepUnsyncedWrites?: boolean
}

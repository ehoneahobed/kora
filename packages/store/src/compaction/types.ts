import type { VersionVector } from '@korajs/core'

/**
 * How the local operation log may be compacted.
 * Materialized collection rows are always kept as the convergence baseline.
 */
export type CompactionStrategy =
	| { mode: 'never' }
	| {
			mode: 'after-ack'
			/** Server version vector; defaults to persisted last-acked vector on the store. */
			serverVector?: VersionVector
	  }
	| {
			mode: 'after-days'
			/** Delete only ops older than this many days (still requires ack watermark). */
			days: number
			serverVector?: VersionVector
	  }

/**
 * Result of a compaction run.
 */
export interface CompactionResult {
	/** Number of operation log rows removed. */
	deletedCount: number
	/** Per-node sequence ceiling used for deletion (from server ack vector). */
	watermark: VersionVector
}

export const COMPACTION_BASELINE_META_KEY = 'compaction_baseline_at'

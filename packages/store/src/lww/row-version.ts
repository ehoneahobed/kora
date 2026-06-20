import { type HLCTimestamp, HybridLogicalClock } from '@korajs/core'
import type { RawCollectionRow } from '../types'

/** Empty _version means legacy rows (compare by wallTime only via fallback). */
export const EMPTY_ROW_VERSION = ''

/**
 * Serialize an HLC timestamp for storage in the `_version` column.
 * Lexicographic order matches {@link HybridLogicalClock.compare}.
 */
export function serializeRowVersion(timestamp: HLCTimestamp): string {
	return HybridLogicalClock.serialize(timestamp)
}

/**
 * Read the version stamp stored on a materialized row.
 * Legacy rows without `_version` fall back to wallTime with logical 0.
 */
export function rowVersionFromRecord(
	row: Pick<RawCollectionRow, '_updated_at' | '_version'>,
): HLCTimestamp {
	const version = row._version
	if (typeof version === 'string' && version.length > 0) {
		return HybridLogicalClock.deserialize(version)
	}
	return { wallTime: row._updated_at, logical: 0, nodeId: '' }
}

/**
 * Returns true when `incoming` is strictly newer than the version on `row`.
 */
export function isIncomingNewerThanRow(
	incoming: HLCTimestamp,
	row: Pick<RawCollectionRow, '_updated_at' | '_version'>,
): boolean {
	return HybridLogicalClock.compare(incoming, rowVersionFromRecord(row)) > 0
}

/**
 * SQL fragment and params for LWW guards: apply only when row is missing or older.
 * Uses serialized `_version` for total order (matches HLC compare).
 */
export function lwwVersionWhereClause(remoteVersion: string): { sql: string; params: string[] } {
	return {
		sql: '(_version = ? OR _version < ?)',
		params: [EMPTY_ROW_VERSION, remoteVersion],
	}
}

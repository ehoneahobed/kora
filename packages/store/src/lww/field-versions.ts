import { EMPTY_ROW_VERSION } from './row-version'

/**
 * Per-field last-writer versions for a materialized row.
 *
 * Each entry maps a field name to a serialized HLC timestamp (the same
 * lexicographically-sortable form used by the row `_version` column). Because
 * the serialized form sorts identically to {@link HybridLogicalClock.compare},
 * per-field last-write-wins is a plain string comparison: the greater string is
 * the newer writer. This makes field-level convergence deterministic and
 * independent of the order operations happen to arrive in.
 */
export type FieldVersions = Record<string, string>

/**
 * Parse the `_field_versions` JSON column into a map. Tolerates null, empty,
 * and malformed values by returning an empty map — a row that predates
 * per-field tracking simply has no field versions and falls back to `_version`.
 */
export function parseFieldVersions(raw: unknown): FieldVersions {
	if (typeof raw !== 'string' || raw.length === 0) {
		return {}
	}
	try {
		const parsed = JSON.parse(raw) as unknown
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return {}
		}
		const result: FieldVersions = {}
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof value === 'string') {
				result[key] = value
			}
		}
		return result
	} catch {
		return {}
	}
}

/**
 * Serialize a field-version map for storage in the `_field_versions` column.
 */
export function serializeFieldVersions(versions: FieldVersions): string {
	return JSON.stringify(versions)
}

/**
 * Build the initial field-version map for an insert: every supplied field is
 * stamped with the operation's version.
 */
export function fieldVersionsForFields(
	fieldNames: Iterable<string>,
	version: string,
): FieldVersions {
	const versions: FieldVersions = {}
	for (const field of fieldNames) {
		versions[field] = version
	}
	return versions
}

/**
 * The effective stored version for a field: its own tracked version if present,
 * otherwise the row-level `_version` (so rows written before per-field tracking
 * still compare correctly), otherwise the empty sentinel (older than anything).
 */
export function effectiveFieldVersion(
	current: FieldVersions,
	field: string,
	rowVersion: string | undefined,
): string {
	const own = current[field]
	if (own !== undefined) {
		return own
	}
	return rowVersion ?? EMPTY_ROW_VERSION
}

/**
 * Result of resolving an incoming operation against the current per-field
 * versions of a row.
 */
export interface PerFieldLwwResult {
	/** Fields the incoming operation wins (strictly newer than the stored version). */
	winners: string[]
	/** The merged field-version map to persist (winners advanced to `incomingVersion`). */
	merged: FieldVersions
}

/**
 * Resolve per-field last-write-wins for an incoming operation.
 *
 * For each incoming field, the operation wins only when its version is strictly
 * greater than the field's effective stored version. Ties (identical version,
 * i.e. the same operation re-applied) are losses, keeping the resolution
 * idempotent. The comparison is a total order, so every node resolves the same
 * winner regardless of the order operations arrive.
 *
 * @param current - Parsed `_field_versions` of the target row
 * @param incomingFields - Field names carried by the incoming operation
 * @param incomingVersion - Serialized HLC version of the incoming operation
 * @param rowVersion - The row's `_version` (fallback for untracked fields)
 */
export function resolvePerFieldLww(
	current: FieldVersions,
	incomingFields: Iterable<string>,
	incomingVersion: string,
	rowVersion: string | undefined,
): PerFieldLwwResult {
	const winners: string[] = []
	const merged: FieldVersions = { ...current }
	for (const field of incomingFields) {
		const stored = effectiveFieldVersion(current, field, rowVersion)
		if (incomingVersion > stored) {
			winners.push(field)
			merged[field] = incomingVersion
		}
		// Losing fields are left untouched: their existing tracked version (or the
		// row-level `_version` fallback) already reflects the newer writer.
	}
	return { winners, merged }
}

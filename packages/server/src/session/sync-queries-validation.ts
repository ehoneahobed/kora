/** Most entries a handshake's `syncQueries` may hold by default (see KoraSyncServerConfig.maxSyncQueries). */
export const DEFAULT_MAX_SYNC_QUERIES = 1000

/** Most fields one `syncQueries` entry's `where` may hold. */
export const MAX_SYNC_QUERY_FIELDS = 32

/** Why a handshake's `syncQueries` is refused, or null when it is acceptable. */
export type SyncQueriesVerdict = {
	code: 'SYNC_QUERIES_LIMIT' | 'INVALID_SYNC_QUERIES'
	message: string
} | null

/**
 * Check a handshake's client-supplied `syncQueries` before the server works on it: absent, or
 * an array of at most `max` entries, each `{ collection: non-empty string, where: plain object
 * of at most MAX_SYNC_QUERY_FIELDS fields }`. A list the server would otherwise deduplicate and
 * evaluate on every delivery cannot be made arbitrarily large or malformed.
 */
export function checkSyncQueries(value: unknown, max: number): SyncQueriesVerdict {
	if (value === undefined || value === null) return null
	if (!Array.isArray(value)) {
		return { code: 'INVALID_SYNC_QUERIES', message: 'syncQueries must be an array.' }
	}
	if (value.length > max) {
		return {
			code: 'SYNC_QUERIES_LIMIT',
			message: `syncQueries holds ${value.length} entries; this server accepts at most ${max} (maxSyncQueries).`,
		}
	}
	for (const [index, entry] of value.entries()) {
		if (!isPlainObject(entry)) {
			return { code: 'INVALID_SYNC_QUERIES', message: `syncQueries[${index}] must be an object.` }
		}
		if (typeof entry.collection !== 'string' || entry.collection.length === 0) {
			return {
				code: 'INVALID_SYNC_QUERIES',
				message: `syncQueries[${index}].collection must be a non-empty string.`,
			}
		}
		if (!isPlainObject(entry.where)) {
			return {
				code: 'INVALID_SYNC_QUERIES',
				message: `syncQueries[${index}].where must be an object.`,
			}
		}
		if (Object.keys(entry.where).length > MAX_SYNC_QUERY_FIELDS) {
			return {
				code: 'INVALID_SYNC_QUERIES',
				message: `syncQueries[${index}].where has more than ${MAX_SYNC_QUERY_FIELDS} fields.`,
			}
		}
	}
	return null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
	const proto = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}

/**
 * An order-independent digest of a collection's rows, computed identically by the server
 * (from its materialized rows) and by the browser (from the local store), so the harness
 * can check that the device holds exactly the records and field values the server holds
 * without shipping every row back to Node. Plain JavaScript only: the page bundles it.
 */

/** The schema fields the digest covers (the LMS fixture's fields). */
const DIGEST_FIELDS = [
	'schoolId',
	'ownerId',
	'title',
	'body',
	'status',
	'score',
	'position',
] as const

export interface CollectionDigest {
	count: number
	/** Sum (mod 2^32) of a per-row FNV-1a hash. */
	sum: number
}

function fnv1a(text: string): number {
	let hash = 0x811c9dc5
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193)
	}
	return hash >>> 0
}

/** Digest of rows with an `id` and the fixture's fields. */
export function digestRows(rows: ReadonlyArray<Record<string, unknown>>): CollectionDigest {
	let sum = 0
	for (const row of rows) {
		const parts = [String(row.id)]
		for (const field of DIGEST_FIELDS) parts.push(String(row[field] ?? ''))
		sum = (sum + fnv1a(parts.join('\u0000'))) >>> 0
	}
	return { count: rows.length, sum }
}

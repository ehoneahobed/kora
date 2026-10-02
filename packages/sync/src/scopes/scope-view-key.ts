/**
 * Canonical key of a downlink scope map (SYNC-11). The client keys its per-view
 * delivery watermark by the scope the server ACCEPTED and reports that scope's key at
 * the next handshake; the server computes the key of the scope it resolves now and
 * resumes the delivery stream from the reported watermark only when the two match.
 * Both sides must therefore compute it the same way, from scopes that may have been
 * re-ordered or round-tripped through JSON: object keys are sorted, `undefined` entries
 * dropped, and `$in` lists de-duplicated and sorted. No scope (undefined or null) is
 * the empty string.
 */
export function scopeViewKey(
	scope: Record<string, Record<string, unknown>> | null | undefined,
): string {
	if (scope === null || scope === undefined) return ''
	return canonicalJson(normalizeValue(scope))
}

function normalizeValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeValue)
	if (value === null || typeof value !== 'object') return value
	const record = value as Record<string, unknown>
	const out: Record<string, unknown> = {}
	for (const key of Object.keys(record)) {
		const entry = record[key]
		if (entry === undefined) continue
		if (key === '$in' && Array.isArray(entry)) {
			const byKey = new Map<string, unknown>()
			for (const item of entry) {
				const normalized = normalizeValue(item)
				byKey.set(canonicalJson(normalized), normalized)
			}
			out[key] = [...byKey.keys()].sort().map((k) => byKey.get(k))
			continue
		}
		out[key] = normalizeValue(entry)
	}
	return out
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
	const record = value as Record<string, unknown>
	const entries = Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
	return `{${entries.join(',')}}`
}

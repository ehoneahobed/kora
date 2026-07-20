/**
 * Human-readable remediation hints keyed by {@link KoraError} `code`.
 */
export const KORA_ERROR_FIX_SUGGESTIONS: Record<string, string> = {
	SCHEMA_VALIDATION:
		'Review your defineSchema() definition: every collection needs at least one field and a positive version.',
	OPERATION_ERROR:
		'Check the operation payload matches your schema field types and required fields.',
	MERGE_CONFLICT:
		'Add a custom resolver for the conflicting field in defineSchema(), or adjust constraint onConflict rules.',
	SYNC_ERROR:
		'Verify the sync server URL, auth token, and that the server accepts your schema version.',
	STORAGE_ERROR:
		'Confirm the storage adapter is supported in this environment and the database path is writable.',
	CLOCK_DRIFT:
		'Sync device wall-clock time (NTP). Kora refuses new timestamps when drift exceeds five minutes.',
	INVALID_TIMESTAMP_FIELDS:
		'HLC timestamps need non-negative integer wallTime (< 10^15) and logical (<= 99999). Generate timestamps through HybridLogicalClock instead of building them by hand.',
	PERSISTENCE_ERROR:
		'IndexedDB persistence failed; check browser storage settings and available disk quota.',
	MISSING_WORKER_URL:
		'Pass store.workerUrl pointing to sqlite-wasm-worker.js (see create-kora-app templates).',
	INVALID_SYNC_URL:
		'Use ws:// or wss:// for WebSocket transport, or http(s):// for HTTP long-polling.',
	APP_NOT_READY:
		'Await app.ready before querying or mutating collections, or wrap the tree in <KoraProvider app={app}>.',
}

/**
 * Returns a suggested fix for a Kora error code, if one is known.
 */
export function getKoraErrorFix(code: string): string | undefined {
	return KORA_ERROR_FIX_SUGGESTIONS[code]
}

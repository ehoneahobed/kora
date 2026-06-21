import type { Operation, VersionVector } from '@korajs/core'
import { createVersionVector } from '@korajs/core'
import type { MetaRow, StorageAdapter } from '../types'

export const LAST_ACKED_SERVER_VECTOR_META_KEY = 'last_acked_server_vector'
export const DELTA_CURSOR_META_KEY = 'delta_cursor'

/**
 * Serialize a version vector for `_kora_meta` storage.
 */
export function serializeVersionVectorToMeta(vector: VersionVector): string {
	const record: Record<string, number> = {}
	for (const [nodeId, seq] of vector) {
		record[nodeId] = seq
	}
	return JSON.stringify(record)
}

/**
 * Deserialize a version vector from `_kora_meta`.
 */
export function deserializeVersionVectorFromMeta(value: string): VersionVector {
	const parsed = JSON.parse(value) as Record<string, number>
	const vector = createVersionVector()
	for (const [nodeId, seq] of Object.entries(parsed)) {
		if (typeof seq === 'number' && seq >= 0) {
			vector.set(nodeId, seq)
		}
	}
	return vector
}

/**
 * Merge two version vectors, keeping the maximum sequence per node.
 */
export function mergeVersionVectors(a: VersionVector, b: VersionVector): VersionVector {
	const merged = new Map(a)
	for (const [nodeId, seq] of b) {
		merged.set(nodeId, Math.max(merged.get(nodeId) ?? 0, seq))
	}
	return merged
}

/**
 * Operations present locally but not yet on the server (per server version vector).
 */
export async function collectOperationsAheadOfServer(
	localVector: VersionVector,
	serverVector: VersionVector,
	fetchRange: (nodeId: string, fromSeq: number, toSeq: number) => Promise<Operation[]>,
): Promise<Operation[]> {
	const missing: Operation[] = []
	for (const [nodeId, localSeq] of localVector) {
		const serverSeq = serverVector.get(nodeId) ?? 0
		if (localSeq > serverSeq) {
			const ops = await fetchRange(nodeId, serverSeq + 1, localSeq)
			missing.push(...ops)
		}
	}
	missing.sort((a, b) => a.sequenceNumber - b.sequenceNumber)
	return missing
}

/**
 * Load persisted last-acked server vector from `_kora_meta`.
 */
export async function loadLastAckedServerVector(adapter: StorageAdapter): Promise<VersionVector> {
	const rows = await adapter.query<MetaRow>('SELECT value FROM _kora_meta WHERE key = ?', [
		LAST_ACKED_SERVER_VECTOR_META_KEY,
	])
	const row = rows[0]
	if (!row?.value) {
		return createVersionVector()
	}
	try {
		return deserializeVersionVectorFromMeta(row.value)
	} catch {
		return createVersionVector()
	}
}

/**
 * Persist the last-acked server version vector to `_kora_meta`.
 */
export async function saveLastAckedServerVector(
	adapter: StorageAdapter,
	vector: VersionVector,
): Promise<void> {
	await adapter.execute('INSERT OR REPLACE INTO _kora_meta (key, value) VALUES (?, ?)', [
		LAST_ACKED_SERVER_VECTOR_META_KEY,
		serializeVersionVectorToMeta(vector),
	])
}

/**
 * Load a persisted delta cursor for resuming paginated initial sync.
 */
export async function loadDeltaCursor(adapter: StorageAdapter): Promise<string | null> {
	const rows = await adapter.query<MetaRow>('SELECT value FROM _kora_meta WHERE key = ?', [
		DELTA_CURSOR_META_KEY,
	])
	return rows[0]?.value ?? null
}

/**
 * Persist or clear the delta cursor in `_kora_meta`.
 */
export async function saveDeltaCursor(
	adapter: StorageAdapter,
	cursor: string | null,
): Promise<void> {
	if (cursor === null) {
		await adapter.execute('DELETE FROM _kora_meta WHERE key = ?', [DELTA_CURSOR_META_KEY])
		return
	}

	await adapter.execute('INSERT OR REPLACE INTO _kora_meta (key, value) VALUES (?, ?)', [
		DELTA_CURSOR_META_KEY,
		cursor,
	])
}

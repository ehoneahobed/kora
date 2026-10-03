import type { Operation, VersionVector } from '@korajs/core'
import { createVersionVector } from '@korajs/core'
import type { MetaRow, StorageAdapter } from '../types'

export const LAST_ACKED_SERVER_VECTOR_META_KEY = 'last_acked_server_vector'
export const DELTA_CURSOR_META_KEY = 'delta_cursor'
export const DELIVERY_WATERMARK_META_KEY = 'delivery_watermark'
export const NODE_TOKEN_META_KEY = 'sync_node_token'
export const AUTHORITATIVE_NODE_IDS_META_KEY = 'sync_authoritative_node_ids'

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
 * Load the per-device node token the sync server issued for this node id (RT-12).
 */
export async function loadNodeToken(
	adapter: StorageAdapter,
	nodeId?: string,
): Promise<string | null> {
	if (nodeId !== undefined) {
		const own = await adapter.query<MetaRow>('SELECT value FROM _kora_meta WHERE key = ?', [
			nodeTokenKey(nodeId),
		])
		if (own[0]) return own[0].value
		// The legacy single key belongs to the database's node id (`_kora_meta.node_id`).
		const meta = await adapter.query<MetaRow>("SELECT value FROM _kora_meta WHERE key = 'node_id'")
		if (meta[0]?.value !== nodeId) return null
	}
	const rows = await adapter.query<MetaRow>('SELECT value FROM _kora_meta WHERE key = ?', [
		NODE_TOKEN_META_KEY,
	])
	return rows[0]?.value ?? null
}

/** `_kora_meta` key of one node id's token (RT-38/RT-40: a database may use several). */
export function nodeTokenKey(nodeId: string): string {
	return `${NODE_TOKEN_META_KEY}:${nodeId}`
}

/**
 * Persist the per-device node token next to the node id in `_kora_meta`. With a node
 * id, the token is stored under that node's own key: a database that uses several node
 * ids (a rotated identity, per-tab isolation) keeps each node's token.
 */
export async function saveNodeToken(
	adapter: StorageAdapter,
	token: string,
	nodeId?: string,
): Promise<void> {
	await adapter.execute('INSERT OR REPLACE INTO _kora_meta (key, value) VALUES (?, ?)', [
		nodeId === undefined ? NODE_TOKEN_META_KEY : nodeTokenKey(nodeId),
		token,
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

/**
 * The `_kora_meta` key for a view's delivery watermark. The default (empty) signature
 * uses the bare key for backward compatibility; other views suffix the signature.
 */
export function deliveryWatermarkKey(signature: string): string {
	return signature === ''
		? DELIVERY_WATERMARK_META_KEY
		: `${DELIVERY_WATERMARK_META_KEY}:${signature}`
}

/**
 * Load the persisted delivery watermark for a view signature (0 when none recorded).
 */
export async function loadDeliveryWatermark(
	adapter: StorageAdapter,
	signature: string,
): Promise<number> {
	const rows = await adapter.query<MetaRow>('SELECT value FROM _kora_meta WHERE key = ?', [
		deliveryWatermarkKey(signature),
	])
	const value = rows[0]?.value
	if (value === undefined || value === null) {
		return 0
	}
	const parsed = Number(value)
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

/**
 * Persist the delivery watermark for a view signature in `_kora_meta`.
 */
export async function saveDeliveryWatermark(
	adapter: StorageAdapter,
	signature: string,
	watermark: number,
): Promise<void> {
	await adapter.execute('INSERT OR REPLACE INTO _kora_meta (key, value) VALUES (?, ?)', [
		deliveryWatermarkKey(signature),
		String(watermark),
	])
}

/**
 * Delete a persisted view watermark. Dropping a watermark is always safe: the view simply
 * back-fills from 0 (deduplicated) the next time it is visited. This bounds the number of
 * `_kora_meta` rows an app that churns through many distinct views can accumulate.
 */
export async function deleteDeliveryWatermark(
	adapter: StorageAdapter,
	signature: string,
): Promise<void> {
	await adapter.execute('DELETE FROM _kora_meta WHERE key = ?', [deliveryWatermarkKey(signature)])
}

/**
 * Load every persisted view watermark, keyed by signature (the default view is '').
 */
export async function loadAllDeliveryWatermarks(
	adapter: StorageAdapter,
): Promise<Record<string, number>> {
	const rows = await adapter.query<MetaRow & { key: string }>(
		'SELECT key, value FROM _kora_meta WHERE key = ? OR key LIKE ?',
		[DELIVERY_WATERMARK_META_KEY, `${DELIVERY_WATERMARK_META_KEY}:%`],
	)
	const result: Record<string, number> = {}
	const prefix = `${DELIVERY_WATERMARK_META_KEY}:`
	for (const row of rows) {
		const signature = row.key === DELIVERY_WATERMARK_META_KEY ? '' : row.key.slice(prefix.length)
		const parsed = Number(row.value)
		if (Number.isFinite(parsed) && parsed >= 0) {
			result[signature] = parsed
		}
	}
	return result
}

/**
 * Persist the node ids the sync server named authoritative (protocol v2): their
 * operations are server-authored. Stored as a JSON array in `_kora_meta`.
 */
export async function saveAuthoritativeNodeIds(
	adapter: StorageAdapter,
	nodeIds: string[],
): Promise<void> {
	await adapter.execute('INSERT OR REPLACE INTO _kora_meta (key, value) VALUES (?, ?)', [
		AUTHORITATIVE_NODE_IDS_META_KEY,
		JSON.stringify(nodeIds),
	])
}

/** `_kora_meta` key of the explicit authoritative ids a server revoked (RT-81). */
const REVOKED_AUTHORITATIVE_NODE_IDS_META_KEY = 'sync_revoked_authoritative_node_ids'

/**
 * Persist the explicit authoritative node ids a sync server revoked (RT-81). A revoked
 * id is never authoritative again on this device, whatever a later handshake lists.
 */
export async function saveRevokedAuthoritativeNodeIds(
	adapter: StorageAdapter,
	nodeIds: string[],
): Promise<void> {
	await adapter.execute('INSERT OR REPLACE INTO _kora_meta (key, value) VALUES (?, ?)', [
		REVOKED_AUTHORITATIVE_NODE_IDS_META_KEY,
		JSON.stringify(nodeIds),
	])
}

/** Load the persisted revoked authoritative node ids (empty when none, or unreadable). */
export async function loadRevokedAuthoritativeNodeIds(adapter: StorageAdapter): Promise<string[]> {
	const rows = await adapter.query<MetaRow>('SELECT value FROM _kora_meta WHERE key = ?', [
		REVOKED_AUTHORITATIVE_NODE_IDS_META_KEY,
	])
	const raw = rows[0]?.value
	if (raw === undefined) return []
	try {
		const parsed: unknown = JSON.parse(raw)
		if (Array.isArray(parsed)) return parsed.filter((id): id is string => typeof id === 'string')
	} catch {
		// Unreadable: no revocation known; the next handshake that carries one rewrites it.
	}
	return []
}

/**
 * Load the persisted authoritative node ids, or null when no protocol-2 server ever
 * answered (or the stored value is unreadable).
 */
export async function loadAuthoritativeNodeIds(adapter: StorageAdapter): Promise<string[] | null> {
	const rows = await adapter.query<MetaRow>('SELECT value FROM _kora_meta WHERE key = ?', [
		AUTHORITATIVE_NODE_IDS_META_KEY,
	])
	const raw = rows[0]?.value
	if (raw === undefined) return null
	try {
		const parsed: unknown = JSON.parse(raw)
		if (Array.isArray(parsed) && parsed.every((id) => typeof id === 'string')) {
			return parsed as string[]
		}
	} catch {
		// Unreadable: treated as never received; the next handshake rewrites it.
	}
	return null
}

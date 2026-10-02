import type { Operation } from '@korajs/core'
import type { MetaRow, StorageAdapter } from '../types'
import { deliveryWatermarkKey } from './sync-state'

/** `_kora_meta` key of this device's contiguous acknowledged own-operation prefix (W3). */
export const OWN_ACKED_THROUGH_META_KEY = 'own_acked_through'
/** `_kora_meta` key of the downlink scope the sync server last accepted (SYNC-11). */
export const ACCEPTED_DOWNLINK_SCOPE_META_KEY = 'accepted_downlink_scope'

/**
 * Durable inbound quarantine (W4): delivered operations the client deliberately did not
 * apply, kept so they are never silently lost and can be replayed. Created on first use
 * so existing databases need no migration.
 */
const UNAPPLIED_OPS_DDL =
	'CREATE TABLE IF NOT EXISTS _kora_unapplied_ops (\n' +
	'  op_id TEXT PRIMARY KEY NOT NULL,\n' +
	'  collection TEXT NOT NULL,\n' +
	'  delivery_seq INTEGER,\n' +
	'  code TEXT NOT NULL,\n' +
	'  message TEXT NOT NULL,\n' +
	'  payload TEXT NOT NULL,\n' +
	'  quarantined_at INTEGER NOT NULL\n' +
	')'

/** A delivered operation the client did not apply, as stored in `_kora_unapplied_ops`. */
export interface UnappliedOperation {
	/** The operation as delivered (still encrypted when decryption failed). */
	operation: Operation
	/** Delivery sequence of the batch that carried it, or null for a legacy batch. */
	deliverySequence: number | null
	/** Machine-readable reason. */
	code: string
	/** Human-readable explanation. */
	message: string
	/** Wall-clock time (ms) it was quarantined. Display only. */
	quarantinedAt: number
}

interface UnappliedRow {
	op_id: string
	delivery_seq: number | null
	code: string
	message: string
	payload: string
	quarantined_at: number
}

const ensuredAdapters = new WeakSet<StorageAdapter>()

async function ensureUnappliedTable(adapter: StorageAdapter): Promise<void> {
	if (ensuredAdapters.has(adapter)) return
	await adapter.execute(UNAPPLIED_OPS_DDL)
	ensuredAdapters.add(adapter)
}

/**
 * Record quarantined operations and, when given, advance a view's delivery watermark in
 * the SAME transaction, so the watermark can never pass an operation that is neither
 * applied nor recorded here (the W4 invariant).
 */
export async function saveUnappliedOperations(
	adapter: StorageAdapter,
	entries: UnappliedOperation[],
	watermark?: { signature: string; watermark: number },
): Promise<void> {
	await ensureUnappliedTable(adapter)
	await adapter.transaction(async (tx) => {
		for (const entry of entries) {
			await tx.execute(
				'INSERT OR REPLACE INTO _kora_unapplied_ops (op_id, collection, delivery_seq, code, message, payload, quarantined_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
				[
					entry.operation.id,
					entry.operation.collection,
					entry.deliverySequence,
					entry.code,
					entry.message,
					JSON.stringify(entry.operation),
					entry.quarantinedAt,
				],
			)
		}
		if (watermark) {
			await tx.execute('INSERT OR REPLACE INTO _kora_meta (key, value) VALUES (?, ?)', [
				deliveryWatermarkKey(watermark.signature),
				String(watermark.watermark),
			])
		}
	})
}

/** Every quarantined operation, oldest delivery first. */
export async function loadUnappliedOperations(
	adapter: StorageAdapter,
): Promise<UnappliedOperation[]> {
	await ensureUnappliedTable(adapter)
	const rows = await adapter.query<UnappliedRow>(
		'SELECT op_id, delivery_seq, code, message, payload, quarantined_at FROM _kora_unapplied_ops ORDER BY delivery_seq ASC, quarantined_at ASC',
	)
	return rows.map((row) => ({
		operation: JSON.parse(row.payload) as Operation,
		deliverySequence: row.delivery_seq === null ? null : Number(row.delivery_seq),
		code: row.code,
		message: row.message,
		quarantinedAt: Number(row.quarantined_at),
	}))
}

/** Remove quarantined operations by operation id (applied on replay, or reconciled). */
export async function removeUnappliedOperations(
	adapter: StorageAdapter,
	operationIds: string[],
): Promise<void> {
	if (operationIds.length === 0) return
	await ensureUnappliedTable(adapter)
	const placeholders = operationIds.map(() => '?').join(', ')
	await adapter.execute(
		`DELETE FROM _kora_unapplied_ops WHERE op_id IN (${placeholders})`,
		operationIds,
	)
}

/** `_kora_meta` key of a node's prefix when the legacy single key holds another node's. */
export function ownAckedThroughKey(nodeId: string): string {
	return `${OWN_ACKED_THROUGH_META_KEY}:${nodeId}`
}

function parseLegacyPrefix(value: string | undefined): { nodeId: string; sequence: number } | null {
	if (value === undefined || value === null) return null
	try {
		const parsed = JSON.parse(value) as { nodeId?: unknown; sequence?: unknown }
		if (typeof parsed.nodeId !== 'string') return null
		const sequence =
			typeof parsed.sequence === 'number' && parsed.sequence >= 0 ? parsed.sequence : null
		return sequence === null ? null : { nodeId: parsed.nodeId, sequence }
	} catch {
		return null
	}
}

/**
 * Load the acknowledged own-operation prefix for a node id. Null when none was ever
 * recorded for this node (an upgrade from a release that persisted a max instead).
 *
 * The first node a database tracks keeps the single legacy key (`own_acked_through`, as
 * earlier releases wrote it); any other local node (a rotated node, another tab's node
 * under per-tab isolation, RT-40) has its own key, so tracking one node never erases
 * another node's prefix.
 */
export async function loadOwnAckedThrough(
	adapter: StorageAdapter,
	nodeId: string,
): Promise<number | null> {
	const rows = await adapter.query<MetaRow>('SELECT value FROM _kora_meta WHERE key = ?', [
		OWN_ACKED_THROUGH_META_KEY,
	])
	const legacy = parseLegacyPrefix(rows[0]?.value)
	if (legacy && legacy.nodeId === nodeId) return legacy.sequence
	const own = await adapter.query<MetaRow>('SELECT value FROM _kora_meta WHERE key = ?', [
		ownAckedThroughKey(nodeId),
	])
	const value = own[0]?.value
	if (value === undefined || value === null) return null
	const sequence = Number(value)
	return Number.isInteger(sequence) && sequence >= 0 ? sequence : null
}

/** Persist the acknowledged own-operation prefix for a node id. */
export async function saveOwnAckedThrough(
	adapter: StorageAdapter,
	nodeId: string,
	sequence: number,
): Promise<void> {
	await adapter.transaction(async (tx) => {
		const rows = await tx.query<MetaRow>('SELECT value FROM _kora_meta WHERE key = ?', [
			OWN_ACKED_THROUGH_META_KEY,
		])
		const legacy = parseLegacyPrefix(rows[0]?.value)
		if (legacy === null || legacy.nodeId === nodeId) {
			await tx.execute('INSERT OR REPLACE INTO _kora_meta (key, value) VALUES (?, ?)', [
				OWN_ACKED_THROUGH_META_KEY,
				JSON.stringify({ nodeId, sequence }),
			])
			return
		}
		await tx.execute('INSERT OR REPLACE INTO _kora_meta (key, value) VALUES (?, ?)', [
			ownAckedThroughKey(nodeId),
			String(sequence),
		])
	})
}

/** Load the downlink scope the sync server last accepted (null when none). */
export async function loadAcceptedDownlinkScope(
	adapter: StorageAdapter,
): Promise<Record<string, Record<string, unknown>> | null> {
	const rows = await adapter.query<MetaRow>('SELECT value FROM _kora_meta WHERE key = ?', [
		ACCEPTED_DOWNLINK_SCOPE_META_KEY,
	])
	const value = rows[0]?.value
	if (value === undefined || value === null) return null
	try {
		const parsed = JSON.parse(value) as unknown
		return parsed !== null && typeof parsed === 'object'
			? (parsed as Record<string, Record<string, unknown>>)
			: null
	} catch {
		return null
	}
}

/** Persist (or clear) the downlink scope the sync server last accepted. */
export async function saveAcceptedDownlinkScope(
	adapter: StorageAdapter,
	scope: Record<string, Record<string, unknown>> | null,
): Promise<void> {
	if (scope === null) {
		await adapter.execute('DELETE FROM _kora_meta WHERE key = ?', [
			ACCEPTED_DOWNLINK_SCOPE_META_KEY,
		])
		return
	}
	await adapter.execute('INSERT OR REPLACE INTO _kora_meta (key, value) VALUES (?, ?)', [
		ACCEPTED_DOWNLINK_SCOPE_META_KEY,
		JSON.stringify(scope),
	])
}

import type {
	OfflineCompletion,
	OfflineCompletionMark,
	OfflineMarksSnapshot,
	OfflineUnitKey,
} from '@korajs/core'
import type { MetaRow, StorageAdapter, Transaction } from '../types'

/** `_kora_meta` key prefix of a view's completion mark (offline-readiness design, 4.1). */
export const OFFLINE_MARK_KEY_PREFIX = 'offline_complete:'
/** `_kora_meta` key prefix of an open delivery unit. */
export const OFFLINE_UNIT_KEY_PREFIX = 'offline_unit_open:'

// Keys are scanned by range, not LIKE: view signatures contain `%`, `_` and `:`, and `;`
// is the character after `:` so [prefix, prefix-with-;) covers exactly the prefix.
function prefixRange(prefix: string): [string, string] {
	return [prefix, `${prefix.slice(0, -1)};`]
}

/** The `_kora_meta` key of a view's completion mark. */
export function offlineMarkKey(signature: string): string {
	return `${OFFLINE_MARK_KEY_PREFIX}${signature}`
}

/** The `_kora_meta` key of one delivery unit (the unit id never contains `:`). */
export function offlineUnitKey(signature: string, unitId: string): string {
	return `${OFFLINE_UNIT_KEY_PREFIX}${signature}:${unitId}`
}

type MetaTx = Pick<Transaction, 'execute' | 'query'>

function parseMark(raw: unknown): OfflineCompletionMark | null {
	if (typeof raw !== 'string') return null
	try {
		const value = JSON.parse(raw) as Partial<OfflineCompletionMark> | null
		if (
			value === null ||
			typeof value !== 'object' ||
			typeof value.signature !== 'string' ||
			typeof value.watermark !== 'number' ||
			typeof value.scopeKey !== 'string' ||
			!Array.isArray(value.subsets) ||
			typeof value.collectionsKey !== 'string' ||
			typeof value.at !== 'number'
		) {
			return null
		}
		return {
			signature: value.signature,
			watermark: value.watermark,
			scopeKey: value.scopeKey,
			subsets: value.subsets,
			rulesKey: value.rulesKey ?? null,
			principal: value.principal ?? null,
			collectionsKey: value.collectionsKey,
			at: value.at,
		}
	} catch {
		// An unreadable mark proves nothing: the view reads as incomplete.
		return null
	}
}

function parseUnit(raw: unknown): OfflineUnitKey | null {
	if (typeof raw !== 'string') return null
	try {
		const value = JSON.parse(raw) as Partial<OfflineUnitKey> | null
		if (
			value === null ||
			typeof value !== 'object' ||
			typeof value.signature !== 'string' ||
			typeof value.unitId !== 'string' ||
			typeof value.base !== 'number' ||
			typeof value.upTo !== 'number'
		) {
			return null
		}
		return { signature: value.signature, unitId: value.unitId, base: value.base, upTo: value.upTo }
	} catch {
		// An unreadable unit key is kept (never deleted): its presence blocks `complete`.
		return null
	}
}

async function scan(tx: MetaTx, prefix: string): Promise<Array<{ key: string; value: unknown }>> {
	const [low, high] = prefixRange(prefix)
	return tx.query<MetaRow & { key: string }>(
		'SELECT key, value FROM _kora_meta WHERE key >= ? AND key < ?',
		[low, high],
	)
}

/**
 * Record that a delivery unit is about to apply operations (before the first one). Its own
 * committed write: whatever persists an operation of the unit persists this key too.
 */
export async function openOfflineUnit(tx: MetaTx, unit: OfflineUnitKey): Promise<void> {
	await tx.execute('INSERT OR REPLACE INTO _kora_meta (key, value) VALUES (?, ?)', [
		offlineUnitKey(unit.signature, unit.unitId),
		JSON.stringify(unit),
	])
}

/**
 * Commit a unit's completion through `tx`, in the transaction that advances the view's
 * watermark: set the mark (never backward), close the unit's key and every key of the view
 * the unit covers.
 *
 * A key whose `upTo` is at or below the final watermark belongs to a unit that could only
 * apply operations this unit already applied (it applied every operation of the view up to
 * the watermark, and the fold depends only on the set of operations), so the database is
 * exactly the state at the watermark whatever that unit left. The design also asks for
 * `base >= myBase`; that is dropped here because the engine resumes from the durable
 * watermark, which can lie above a crashed unit's base, and the prefix up to the watermark
 * was already complete.
 */
export async function saveOfflineCompletionInTx(
	tx: MetaTx,
	completion: OfflineCompletion,
): Promise<void> {
	const { mark } = completion
	const existing = parseMark(
		(
			await tx.query<MetaRow>('SELECT value FROM _kora_meta WHERE key = ?', [
				offlineMarkKey(mark.signature),
			])
		)[0]?.value,
	)
	// Marks never go backward: a slower tab finishing an older unit cannot replace a newer
	// mark of the same view with an older one.
	const superseded =
		existing !== null &&
		existing.watermark > mark.watermark &&
		existing.scopeKey === mark.scopeKey &&
		existing.rulesKey === mark.rulesKey &&
		existing.principal === mark.principal &&
		existing.collectionsKey === mark.collectionsKey
	if (!superseded) {
		await tx.execute('INSERT OR REPLACE INTO _kora_meta (key, value) VALUES (?, ?)', [
			offlineMarkKey(mark.signature),
			JSON.stringify(mark),
		])
	}
	if (completion.unitId !== null) {
		await tx.execute('DELETE FROM _kora_meta WHERE key = ?', [
			offlineUnitKey(mark.signature, completion.unitId),
		])
	}
	for (const row of await scan(tx, OFFLINE_UNIT_KEY_PREFIX)) {
		const unit = parseUnit(row.value)
		if (unit !== null && unit.signature === mark.signature && unit.upTo <= mark.watermark) {
			await tx.execute('DELETE FROM _kora_meta WHERE key = ?', [row.key])
		}
	}
}

/** Delete every completion mark (clear-before-apply, and every watermark reset). */
export async function clearOfflineMarks(adapter: StorageAdapter): Promise<void> {
	const [low, high] = prefixRange(OFFLINE_MARK_KEY_PREFIX)
	await adapter.execute('DELETE FROM _kora_meta WHERE key >= ? AND key < ?', [low, high])
}

/** Delete a view's mark and unit keys (its watermark was evicted). */
export async function deleteOfflineViewMarks(
	adapter: StorageAdapter,
	signature: string,
): Promise<void> {
	await adapter.transaction(async (tx) => {
		await tx.execute('DELETE FROM _kora_meta WHERE key = ?', [offlineMarkKey(signature)])
		for (const row of await scan(tx, OFFLINE_UNIT_KEY_PREFIX)) {
			const unit = parseUnit(row.value)
			if (unit !== null && unit.signature === signature) {
				await tx.execute('DELETE FROM _kora_meta WHERE key = ?', [row.key])
			}
		}
	})
}

/**
 * Every mark and unit key. An unreadable unit key is reported with `upTo` infinity and an
 * empty signature so it blocks every view (it can only be cleared by a reset).
 */
export async function loadOfflineMarks(adapter: StorageAdapter): Promise<OfflineMarksSnapshot> {
	const marks: OfflineCompletionMark[] = []
	for (const row of await scan(adapter, OFFLINE_MARK_KEY_PREFIX)) {
		const mark = parseMark(row.value)
		if (mark !== null) marks.push(mark)
	}
	const units: OfflineUnitKey[] = []
	for (const row of await scan(adapter, OFFLINE_UNIT_KEY_PREFIX)) {
		units.push(
			parseUnit(row.value) ?? {
				signature: '',
				unitId: row.key,
				base: 0,
				upTo: Number.POSITIVE_INFINITY,
			},
		)
	}
	return { marks, units }
}

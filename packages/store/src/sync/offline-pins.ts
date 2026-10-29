import { OFFLINE_PIN_LIMIT, OfflineKeepError } from '@korajs/core'
import type { StorageAdapter, Transaction } from '../types'

/**
 * Pins (`app.offline.keep()`, offline-readiness design 4.3) live in two local-only tables.
 * They are not operations and never sync. Created on first open, so existing databases need
 * no migration.
 */
export const OFFLINE_PIN_TABLES_DDL: readonly string[] = [
	'CREATE TABLE IF NOT EXISTS _kora_offline_pins (\n' +
		'  id TEXT PRIMARY KEY NOT NULL,\n' +
		'  collection TEXT NOT NULL,\n' +
		'  where_json TEXT NOT NULL,\n' +
		'  files INTEGER NOT NULL,\n' +
		'  explicit INTEGER NOT NULL,\n' +
		'  created_at INTEGER NOT NULL,\n' +
		'  completed_at INTEGER\n' +
		')',
	'CREATE TABLE IF NOT EXISTS _kora_offline_pin_holds (\n' +
		'  pin_id TEXT NOT NULL,\n' +
		'  holder TEXT NOT NULL,\n' +
		'  tab_id TEXT NOT NULL,\n' +
		'  tab_lock TEXT,\n' +
		'  PRIMARY KEY (pin_id, holder)\n' +
		')',
]

/** A pin as stored. */
export interface StoredOfflinePin {
	id: string
	collection: string
	where: Record<string, unknown>
	files: boolean
	/** Kept by `keep()` and not yet released. */
	explicit: boolean
	createdAt: number
	completedAt: number | null
}

/** A component's hold on a pin, as stored. */
export interface StoredOfflinePinHold {
	pinId: string
	/** This tab's id plus a per-hold id. */
	holder: string
	/** The holder's tab (the `tabId` of its version-gate tab lock). */
	tabId: string
	/** The name of the holder's tab lock, when it has one (what a watcher waits on). */
	tabLock: string | null
}

/** What a pin write changed, so callers know whether to tell the sync view. */
export interface OfflinePinWriteResult {
	/** The pin row was created by this write. */
	created: boolean
	/** The pin row was deleted by this write. */
	deleted: boolean
}

/** The fields a pin is created with. */
export interface NewOfflinePin {
	id: string
	collection: string
	where: Record<string, unknown>
	files: boolean
}

interface PinRow {
	id: string
	collection: string
	where_json: string
	files: number
	explicit: number
	created_at: number
	completed_at: number | null
}

interface HoldRow {
	pin_id: string
	holder: string
	tab_id: string
	tab_lock: string | null
}

type PinTx = Pick<Transaction, 'execute' | 'query'>

/** Create the pin tables if they do not exist. */
export async function ensureOfflinePinTables(adapter: StorageAdapter): Promise<void> {
	for (const ddl of OFFLINE_PIN_TABLES_DDL) await adapter.execute(ddl)
}

function parseWhere(raw: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(raw)
		return value !== null && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {}
	} catch {
		// An unreadable filter must not widen what a pin keeps: keep the pin, match everything
		// in its collection (the over-delivering, never-under-delivering side).
		return {}
	}
}

function toPin(row: PinRow): StoredOfflinePin {
	return {
		id: row.id,
		collection: row.collection,
		where: parseWhere(row.where_json),
		files: row.files === 1,
		explicit: row.explicit === 1,
		createdAt: row.created_at,
		completedAt: row.completed_at,
	}
}

/** Every pin, oldest first. */
export async function loadOfflinePins(
	adapter: Pick<StorageAdapter, 'query'>,
): Promise<StoredOfflinePin[]> {
	const rows = await adapter.query<PinRow>(
		'SELECT id, collection, where_json, files, explicit, created_at, completed_at FROM _kora_offline_pins ORDER BY created_at, id',
	)
	return rows.map(toPin)
}

/** Every hold of every pin. */
export async function loadOfflinePinHolds(
	adapter: Pick<StorageAdapter, 'query'>,
): Promise<StoredOfflinePinHold[]> {
	const rows = await adapter.query<HoldRow>(
		'SELECT pin_id, holder, tab_id, tab_lock FROM _kora_offline_pin_holds ORDER BY pin_id, holder',
	)
	return rows.map((row) => ({
		pinId: row.pin_id,
		holder: row.holder,
		tabId: row.tab_id,
		tabLock: row.tab_lock,
	}))
}

async function pinExists(tx: PinTx, id: string): Promise<boolean> {
	return (
		(await tx.query<{ id: string }>('SELECT id FROM _kora_offline_pins WHERE id = ?', [id]))
			.length > 0
	)
}

/** Create the pin row when it is absent, refusing past the limit. Returns whether it was created. */
async function ensurePinInTx(tx: PinTx, pin: NewOfflinePin, now: number): Promise<boolean> {
	if (await pinExists(tx, pin.id)) return false
	const [count] = await tx.query<{ n: number }>('SELECT COUNT(*) AS n FROM _kora_offline_pins')
	if ((count?.n ?? 0) >= OFFLINE_PIN_LIMIT) {
		throw new OfflineKeepError(
			`This database already keeps ${OFFLINE_PIN_LIMIT} pins (the most it can): collection "${pin.collection}" was not kept.`,
			'OFFLINE_PIN_LIMIT',
			{
				limit: OFFLINE_PIN_LIMIT,
				collection: pin.collection,
				fix: 'Release a pin you no longer need with app.offline.release(), or widen one existing pin instead of adding another.',
			},
		)
	}
	await tx.execute(
		'INSERT INTO _kora_offline_pins (id, collection, where_json, files, explicit, created_at, completed_at) VALUES (?, ?, ?, ?, 0, ?, NULL)',
		[pin.id, pin.collection, JSON.stringify(pin.where), pin.files ? 1 : 0, now],
	)
	return true
}

/** Delete a pin that is not explicit and has no hold. Returns whether it was deleted. */
async function dropOrphanPinInTx(tx: PinTx, id: string): Promise<boolean> {
	const [row] = await tx.query<{ explicit: number }>(
		'SELECT explicit FROM _kora_offline_pins WHERE id = ?',
		[id],
	)
	if (!row || row.explicit === 1) return false
	const [holds] = await tx.query<{ n: number }>(
		'SELECT COUNT(*) AS n FROM _kora_offline_pin_holds WHERE pin_id = ?',
		[id],
	)
	if ((holds?.n ?? 0) > 0) return false
	await tx.execute('DELETE FROM _kora_offline_pins WHERE id = ?', [id])
	return true
}

/** `keep()`: create the pin if absent and mark it explicit. Idempotent. */
export async function keepOfflinePin(
	adapter: StorageAdapter,
	pin: NewOfflinePin,
	now: number,
): Promise<OfflinePinWriteResult> {
	let created = false
	await adapter.transaction(async (tx) => {
		created = await ensurePinInTx(tx, pin, now)
		await tx.execute('UPDATE _kora_offline_pins SET explicit = 1 WHERE id = ?', [pin.id])
	})
	return { created, deleted: false }
}

/** `release()`: clear the explicit flag; the pin goes when no component holds it. */
export async function releaseOfflinePin(
	adapter: StorageAdapter,
	id: string,
	options: { stillHeld?: boolean } = {},
): Promise<OfflinePinWriteResult> {
	let deleted = false
	await adapter.transaction(async (tx) => {
		await tx.execute('UPDATE _kora_offline_pins SET explicit = 0 WHERE id = ?', [id])
		// A hold the store cannot see (explicit mode counts in memory) keeps the pin.
		deleted = options.stillHeld === true ? false : await dropOrphanPinInTx(tx, id)
	})
	return { created: false, deleted }
}

/**
 * Create a pin without marking it kept by the app (a component's hold in `explicit` mode,
 * which has no stored hold rows). An existing pin, kept or not, is left as it is.
 */
export async function ensureOfflinePin(
	adapter: StorageAdapter,
	pin: NewOfflinePin,
	now: number,
): Promise<OfflinePinWriteResult> {
	let created = false
	await adapter.transaction(async (tx) => {
		created = await ensurePinInTx(tx, pin, now)
	})
	return { created, deleted: false }
}

/** A component starts holding a pin (creating it when absent). Idempotent per holder. */
export async function addOfflinePinHold(
	adapter: StorageAdapter,
	pin: NewOfflinePin,
	hold: Omit<StoredOfflinePinHold, 'pinId'>,
	now: number,
): Promise<OfflinePinWriteResult> {
	let created = false
	await adapter.transaction(async (tx) => {
		created = await ensurePinInTx(tx, pin, now)
		await tx.execute(
			'INSERT OR REPLACE INTO _kora_offline_pin_holds (pin_id, holder, tab_id, tab_lock) VALUES (?, ?, ?, ?)',
			[pin.id, hold.holder, hold.tabId, hold.tabLock],
		)
	})
	return { created, deleted: false }
}

/** A component stops holding a pin; the pin goes with its last holder unless it is explicit. */
export async function removeOfflinePinHold(
	adapter: StorageAdapter,
	pinId: string,
	holder: string,
): Promise<OfflinePinWriteResult> {
	let deleted = false
	await adapter.transaction(async (tx) => {
		await tx.execute('DELETE FROM _kora_offline_pin_holds WHERE pin_id = ? AND holder = ?', [
			pinId,
			holder,
		])
		deleted = await dropOrphanPinInTx(tx, pinId)
	})
	return { created: false, deleted }
}

/**
 * Delete the holds of tabs that no longer exist, in one transaction, and the pins that only
 * those holds kept. `isStale` is asked once per distinct holder tab.
 */
export async function pruneOfflinePinHolds(
	adapter: StorageAdapter,
	isStale: (tabId: string) => boolean,
): Promise<{ holdsRemoved: number; pinsRemoved: number }> {
	let holdsRemoved = 0
	let pinsRemoved = 0
	await adapter.transaction(async (tx) => {
		const holds = await tx.query<HoldRow>(
			'SELECT pin_id, holder, tab_id, tab_lock FROM _kora_offline_pin_holds',
		)
		const verdicts = new Map<string, boolean>()
		const touched = new Set<string>()
		for (const hold of holds) {
			let stale = verdicts.get(hold.tab_id)
			if (stale === undefined) {
				stale = isStale(hold.tab_id)
				verdicts.set(hold.tab_id, stale)
			}
			if (!stale) continue
			await tx.execute('DELETE FROM _kora_offline_pin_holds WHERE pin_id = ? AND holder = ?', [
				hold.pin_id,
				hold.holder,
			])
			holdsRemoved++
			touched.add(hold.pin_id)
		}
		for (const id of touched) {
			if (await dropOrphanPinInTx(tx, id)) pinsRemoved++
		}
	})
	return { holdsRemoved, pinsRemoved }
}

/** Record when a pin was last seen complete (display only). */
export async function markOfflinePinCompleted(
	adapter: StorageAdapter,
	id: string,
	at: number | null,
): Promise<void> {
	await adapter.execute('UPDATE _kora_offline_pins SET completed_at = ? WHERE id = ?', [at, id])
}

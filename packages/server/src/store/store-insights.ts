import { createHash } from 'node:crypto'
import { SERVER_LOG_QUARANTINE_TABLE } from './log-integrity'

/** What a server records about a device's connection. Never the device's data. */
export interface DeviceActivity {
	readonly nodeId: string
	readonly seenAt: number
	readonly protocolVersion: number | null
	readonly deliveryWatermark: number | null
}

/**
 * What a device reported about its own sync (a `device-status` message): counts and a failure
 * code, never an operation id or a value.
 */
export interface DeviceHealth {
	readonly nodeId: string
	readonly reportedAt: number
	readonly applyBlocked: boolean
	readonly blockedCode: string | null
	readonly quarantined: number
	readonly pendingOperations: number
	readonly heldOperations: number
	readonly storageDegraded: boolean
}

/**
 * Aggregates about an application's devices and sync history. Counts, timings, and schema names
 * only: nothing here contains a record's values, a user id, or a device's real id, so it can be
 * shared with an operator who has no access to the data.
 */
export interface StoreInsights {
	readonly devices: {
		readonly known: number
		readonly active24h: number
		readonly active7d: number
		readonly active30d: number
		readonly lastSeenAt: number | null
		readonly byProtocolVersion: readonly {
			readonly version: number | null
			readonly devices: number
		}[]
		readonly sync: {
			readonly upToDate: number
			readonly behind: number
			readonly farBehind: number
			readonly unknown: number
		}
		readonly mostBehind: readonly {
			readonly device: string
			readonly lastSeenAt: number
			readonly positionsBehind: number
		}[]
		/**
		 * What devices seen in the last 7 days reported about themselves. Only devices on a
		 * Kora version that reports are counted (`reporting`); older ones are in none of these.
		 */
		readonly health: {
			readonly reporting: number
			/** Delivery stalled on an operation the device can't apply yet. */
			readonly blocked: number
			readonly withQuarantined: number
			readonly quarantinedOperations: number
			/** Devices whose local database couldn't be made durable. */
			readonly storageDegraded: number
			readonly pendingOperations: number
			readonly heldOperations: number
			readonly blockedDevices: readonly {
				readonly device: string
				readonly lastSeenAt: number
				readonly reportedAt: number
				readonly code: string | null
				readonly quarantined: number
			}[]
		}
	}
	readonly people: number
	readonly operations: {
		readonly total: number
		readonly last24h: number
		readonly last7d: number
		readonly lastReceivedAt: number | null
		readonly latestPosition: number
		/** Rows the server's own log-integrity scan set aside (`operations_quarantine`). */
		readonly quarantined: number
		readonly byCollection: readonly {
			readonly collection: string
			readonly inserts: number
			readonly updates: number
			readonly deletes: number
			readonly lastReceivedAt: number
		}[]
	}
	readonly refused: readonly {
		readonly outcome: string
		readonly code: string | null
		readonly operations: number
		readonly lastAt: number
	}[]
}

type Row = Record<string, unknown>

const DAY_MS = 86_400_000
/** Positions behind the newest operation at which a device counts as far behind rather than catching up. */
const FAR_BEHIND_POSITIONS = 1000
const MOST_BEHIND_LIMIT = 20
const COLLECTION_LIMIT = 200

const number = (value: unknown): number => Number(value ?? 0)
const optional = (value: unknown): number | null =>
	value === null || value === undefined ? null : Number(value)

/** A stable label for a device that doesn't reveal its id. */
function deviceLabel(nodeId: string): string {
	return createHash('sha256').update(nodeId).digest('hex').slice(0, 12)
}

/**
 * Computes {@link StoreInsights} with SQL both server stores accept. Only integers computed here
 * are placed in the statements. `latestPosition` is the store's newest delivery sequence.
 */
export async function readStoreInsights(
	query: (text: string) => Promise<readonly Row[]>,
	now: number,
	latestPosition: number,
): Promise<StoreInsights> {
	const position = Math.floor(latestPosition)
	const day = Math.floor(now - DAY_MS)
	const week = Math.floor(now - 7 * DAY_MS)
	const month = Math.floor(now - 30 * DAY_MS)
	const [devices] = await query(`SELECT COUNT(*) AS known,
		COUNT(*) FILTER (WHERE last_seen_at >= ${day}) AS active_day,
		COUNT(*) FILTER (WHERE last_seen_at >= ${week}) AS active_week,
		COUNT(*) FILTER (WHERE last_seen_at >= ${month}) AS active_month,
		MAX(last_seen_at) AS last_seen,
		COUNT(*) FILTER (WHERE delivery_watermark IS NULL) AS sync_unknown,
		COUNT(*) FILTER (WHERE delivery_watermark >= ${position}) AS up_to_date,
		COUNT(*) FILTER (WHERE delivery_watermark < ${position} AND ${position} - delivery_watermark <= ${FAR_BEHIND_POSITIONS}) AS behind,
		COUNT(*) FILTER (WHERE ${position} - delivery_watermark > ${FAR_BEHIND_POSITIONS}) AS far_behind
		FROM kora_device_activity`)
	const versions = await query(
		'SELECT protocol_version AS version, COUNT(*) AS devices FROM kora_device_activity GROUP BY protocol_version ORDER BY devices DESC',
	)
	const behind =
		await query(`SELECT node_id, last_seen_at, ${position} - delivery_watermark AS positions_behind FROM kora_device_activity
		WHERE delivery_watermark < ${position} ORDER BY positions_behind DESC, node_id LIMIT ${MOST_BEHIND_LIMIT}`)
	const [people] = await query(
		"SELECT COUNT(DISTINCT user_id) AS people FROM node_claims WHERE user_id <> ''",
	)
	const [operations] = await query(`SELECT COUNT(*) AS total,
		COUNT(*) FILTER (WHERE received_at >= ${day}) AS last_day,
		COUNT(*) FILTER (WHERE received_at >= ${week}) AS last_week,
		MAX(received_at) AS last_received
		FROM operations`)
	const collections = await query(`SELECT collection,
		COUNT(*) FILTER (WHERE type = 'insert') AS inserts,
		COUNT(*) FILTER (WHERE type = 'update') AS updates,
		COUNT(*) FILTER (WHERE type = 'delete') AS deletes,
		MAX(received_at) AS last_received
		FROM operations GROUP BY collection ORDER BY COUNT(*) DESC LIMIT ${COLLECTION_LIMIT}`)
	const reportingSince = week
	const [health] = await query(`SELECT COUNT(*) AS reporting,
		COUNT(*) FILTER (WHERE apply_blocked = 1) AS blocked,
		COUNT(*) FILTER (WHERE quarantined > 0) AS with_quarantined,
		COALESCE(SUM(quarantined), 0) AS quarantined_operations,
		COUNT(*) FILTER (WHERE storage_degraded = 1) AS storage_degraded,
		COALESCE(SUM(pending_operations), 0) AS pending_operations,
		COALESCE(SUM(held_operations), 0) AS held_operations
		FROM kora_device_activity WHERE health_at IS NOT NULL AND last_seen_at >= ${reportingSince}`)
	const blockedDevices =
		await query(`SELECT node_id, last_seen_at, health_at, blocked_code, quarantined FROM kora_device_activity
		WHERE apply_blocked = 1 AND last_seen_at >= ${reportingSince} ORDER BY last_seen_at DESC, node_id LIMIT ${MOST_BEHIND_LIMIT}`)
	// The table exists once the scan has set anything aside; before that there is nothing to count.
	let serverQuarantined = 0
	try {
		const [row] = await query(`SELECT COUNT(*) AS total FROM ${SERVER_LOG_QUARANTINE_TABLE}`)
		serverQuarantined = number(row?.total)
	} catch {
		serverQuarantined = 0
	}
	const refused =
		await query(`SELECT outcome, code, COUNT(*) AS operations, MAX(resolved_at) AS last_at FROM operation_resolutions
		WHERE outcome <> 'accepted' GROUP BY outcome, code ORDER BY operations DESC LIMIT 100`)
	return {
		devices: {
			known: number(devices?.known),
			active24h: number(devices?.active_day),
			active7d: number(devices?.active_week),
			active30d: number(devices?.active_month),
			lastSeenAt: optional(devices?.last_seen),
			byProtocolVersion: versions.map((row) => ({
				version: optional(row.version),
				devices: number(row.devices),
			})),
			sync: {
				upToDate: number(devices?.up_to_date),
				behind: number(devices?.behind),
				farBehind: number(devices?.far_behind),
				unknown: number(devices?.sync_unknown),
			},
			mostBehind: behind.map((row) => ({
				device: deviceLabel(String(row.node_id)),
				lastSeenAt: number(row.last_seen_at),
				positionsBehind: number(row.positions_behind),
			})),
			health: {
				reporting: number(health?.reporting),
				blocked: number(health?.blocked),
				withQuarantined: number(health?.with_quarantined),
				quarantinedOperations: number(health?.quarantined_operations),
				storageDegraded: number(health?.storage_degraded),
				pendingOperations: number(health?.pending_operations),
				heldOperations: number(health?.held_operations),
				blockedDevices: blockedDevices.map((row) => ({
					device: deviceLabel(String(row.node_id)),
					lastSeenAt: number(row.last_seen_at),
					reportedAt: number(row.health_at),
					code:
						row.blocked_code === null || row.blocked_code === undefined
							? null
							: String(row.blocked_code),
					quarantined: number(row.quarantined),
				})),
			},
		},
		people: number(people?.people),
		operations: {
			total: number(operations?.total),
			last24h: number(operations?.last_day),
			last7d: number(operations?.last_week),
			lastReceivedAt: optional(operations?.last_received),
			latestPosition: position,
			quarantined: serverQuarantined,
			byCollection: collections.map((row) => ({
				collection: String(row.collection),
				inserts: number(row.inserts),
				updates: number(row.updates),
				deletes: number(row.deletes),
				lastReceivedAt: number(row.last_received),
			})),
		},
		refused: refused.map((row) => ({
			outcome: String(row.outcome),
			code: row.code === null || row.code === undefined ? null : String(row.code),
			operations: number(row.operations),
			lastAt: number(row.last_at),
		})),
	}
}

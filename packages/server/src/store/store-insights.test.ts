import { defineSchema, t } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, describe, expect, test } from 'vitest'
import { dropTrackedPgSchemas, trackPgSchema } from '../../tests/fixtures/pg-test-schemas'
import { PostgresServerStore } from './postgres-server-store'
import { type SqliteServerStore, createSqliteServerStore } from './sqlite-server-store'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

async function seeded(): Promise<SqliteServerStore> {
	const store = createSqliteServerStore({ filename: ':memory:' })
	await store.recordDeviceActivity({
		nodeId: 'device-today',
		seenAt: NOW - HOUR,
		protocolVersion: 2,
		deliveryWatermark: 0,
	})
	await store.recordDeviceActivity({
		nodeId: 'device-this-week',
		seenAt: NOW - 3 * DAY,
		protocolVersion: 2,
		deliveryWatermark: null,
	})
	await store.recordDeviceActivity({
		nodeId: 'device-long-gone',
		seenAt: NOW - 60 * DAY,
		protocolVersion: 1,
		deliveryWatermark: null,
	})
	return store
}

describe('store insights', () => {
	test('active devices are counted by when they were last seen', async () => {
		const { devices } = await (await seeded()).getStoreInsights(NOW)
		expect(devices).toMatchObject({
			known: 3,
			active24h: 1,
			active7d: 2,
			active30d: 2,
			lastSeenAt: NOW - HOUR,
		})
	})

	test('devices are grouped by the protocol they speak', async () => {
		const { devices } = await (await seeded()).getStoreInsights(NOW)
		expect(devices.byProtocolVersion).toEqual([
			{ version: 2, devices: 2 },
			{ version: 1, devices: 1 },
		])
	})

	test('a device that stops reporting a position keeps its last known one', async () => {
		const store = await seeded()
		await store.recordDeviceActivity({
			nodeId: 'device-today',
			seenAt: NOW,
			protocolVersion: null,
			deliveryWatermark: null,
		})
		const { devices } = await store.getStoreInsights(NOW)
		expect(devices.sync.unknown).toBe(2)
		expect(devices.byProtocolVersion[0]).toEqual({ version: 2, devices: 2 })
	})

	test('an out-of-order report cannot move last seen backwards', async () => {
		const store = await seeded()
		await store.recordDeviceActivity({
			nodeId: 'device-today',
			seenAt: NOW - 10 * DAY,
			protocolVersion: 2,
			deliveryWatermark: 0,
		})
		expect((await store.getStoreInsights(NOW)).devices.lastSeenAt).toBe(NOW - HOUR)
	})

	test('nothing identifying leaves the store', async () => {
		const store = await seeded()
		const text = JSON.stringify(await store.getStoreInsights(NOW))
		expect(text).not.toContain('device-today')
		expect(text).not.toContain('device-long-gone')
	})

	test('an empty store reports zeros, not errors', async () => {
		const store = createSqliteServerStore({ filename: ':memory:' })
		const insights = await store.getStoreInsights(NOW)
		expect(insights.devices.known).toBe(0)
		expect(insights.operations.total).toBe(0)
		expect(insights.devices.lastSeenAt).toBeNull()
		expect(insights.refused).toEqual([])
	})

	test('what devices report about themselves is counted, for devices seen this week only', async () => {
		const store = await seeded()
		const report = (
			nodeId: string,
			extra: Partial<Parameters<SqliteServerStore['recordDeviceHealth']>[0]> = {},
		) =>
			store.recordDeviceHealth({
				nodeId,
				reportedAt: NOW - HOUR,
				applyBlocked: false,
				blockedCode: null,
				quarantined: 0,
				pendingOperations: 0,
				heldOperations: 0,
				storageDegraded: false,
				...extra,
			})
		await report('device-today', {
			applyBlocked: true,
			blockedCode: 'MISSING_TRANSFORM',
			quarantined: 2,
			pendingOperations: 5,
		})
		await report('device-this-week', { storageDegraded: true, heldOperations: 3 })
		// Seen two months ago: whatever it said then says nothing about now.
		await report('device-long-gone', {
			applyBlocked: true,
			quarantined: 9,
			reportedAt: NOW - 60 * DAY,
		})
		const { devices } = await store.getStoreInsights(NOW)
		expect(devices.health).toMatchObject({
			reporting: 2,
			blocked: 1,
			withQuarantined: 1,
			quarantinedOperations: 2,
			storageDegraded: 1,
			pendingOperations: 5,
			heldOperations: 3,
		})
		expect(devices.health.blockedDevices).toHaveLength(1)
		expect(devices.health.blockedDevices[0]).toMatchObject({
			code: 'MISSING_TRANSFORM',
			quarantined: 2,
		})
		expect(devices.health.blockedDevices[0]?.device).toMatch(/^[a-f0-9]{12}$/)
		expect(JSON.stringify(devices)).not.toContain('device-today')
	})

	test('a report keeps last seen moving forward and clears a block that ended', async () => {
		const store = await seeded()
		const base = {
			reportedAt: NOW,
			blockedCode: null,
			quarantined: 0,
			pendingOperations: 0,
			heldOperations: 0,
			storageDegraded: false,
		}
		await store.recordDeviceHealth({
			...base,
			nodeId: 'device-today',
			applyBlocked: true,
			blockedCode: 'APPLY_FAILED',
		})
		await store.recordDeviceHealth({ ...base, nodeId: 'device-today', applyBlocked: false })
		const { devices } = await store.getStoreInsights(NOW)
		expect(devices.health.blocked).toBe(0)
		expect(devices.lastSeenAt).toBe(NOW)
	})

	test("the server's own set-aside operations are counted once its scan has made the table", async () => {
		const store = await seeded()
		expect((await store.getStoreInsights(NOW)).operations.quarantined).toBe(0)
	})
})

const PG_URL = process.env.KORA_PG_TEST_URL

describe.skipIf(!PG_URL)('postgres: device health', () => {
	const clients: ReturnType<typeof postgres>[] = []
	afterAll(async () => {
		for (const client of clients) await client.end()
		await dropTrackedPgSchemas()
	})

	test('a database from before device health gains its columns, and reports are counted', async () => {
		const name = `kora_health_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
		const admin = postgres(PG_URL ?? '', { max: 1 })
		await admin.unsafe(`CREATE SCHEMA ${name}`)
		trackPgSchema(name)
		// The table as earlier versions made it, with a device already in it.
		await admin.unsafe(
			`CREATE TABLE ${name}.kora_device_activity (node_id TEXT PRIMARY KEY, first_seen_at BIGINT NOT NULL, last_seen_at BIGINT NOT NULL, protocol_version INTEGER, delivery_watermark BIGINT)`,
		)
		await admin.unsafe(
			`INSERT INTO ${name}.kora_device_activity VALUES ('old-device', ${NOW - DAY}, ${NOW - DAY}, 2, 0)`,
		)
		await admin.end()
		const client = postgres(PG_URL ?? '', { max: 2, connection: { search_path: name } })
		clients.push(client)
		const store = new PostgresServerStore(drizzle(client), 'server-node')
		await store.setSchema(
			defineSchema({ version: 1, collections: { todos: { fields: { title: t.string() } } } }),
		)
		await store.recordDeviceHealth({
			nodeId: 'old-device',
			reportedAt: NOW - HOUR,
			applyBlocked: true,
			blockedCode: 'DECRYPT_FAILED',
			quarantined: 4,
			pendingOperations: 1,
			heldOperations: 0,
			storageDegraded: false,
		})
		const insights = await store.getStoreInsights(NOW)
		expect(insights.devices.health).toMatchObject({
			reporting: 1,
			blocked: 1,
			quarantinedOperations: 4,
			pendingOperations: 1,
		})
		expect(insights.devices.health.blockedDevices[0]).toMatchObject({
			code: 'DECRYPT_FAILED',
			lastSeenAt: NOW - HOUR,
		})
		expect(insights.operations.quarantined).toBe(0)
		await store.close()
	})
})

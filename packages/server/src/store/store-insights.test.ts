import { describe, expect, test } from 'vitest'
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
})

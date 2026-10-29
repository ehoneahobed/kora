/**
 * Offline readiness, end to end (offline-readiness design 4.1, A2): a device is `complete`
 * only when a durable completion mark proves its view was fully delivered, and a unit that
 * crashed or stalled mid-way is never `complete` after a reload.
 *
 * A real server, a writer device, and a reading device (real Store on a SQLite file, the
 * korajs merge-aware sync store and sync-state persistence, a real SyncEngine). "Reload
 * offline" is a new engine over the same database whose transport cannot connect.
 */
import { defineSchema, t } from '@korajs/core'
import { MergeEngine } from '@korajs/merge'
import { createServerTransportPair } from '@korajs/server/internal'
import { SyncEngine, type SyncTransport } from '@korajs/sync'
import { createMemoryTransportPair } from '@korajs/sync/internal'
import { MergeAwareSyncStore, StoreSyncStatePersistence } from 'korajs/testing'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { TestDevice, TestNetwork } from '../src/index'
import { createTestNetwork } from '../src/index'

const schema = defineSchema({
	version: 1,
	collections: { lessons: { fields: { title: t.string() } } },
})

let network: TestNetwork | null = null
const engines: SyncEngine[] = []

afterEach(async () => {
	for (const engine of engines.splice(0)) await engine.destroy().catch(() => {})
	if (network) {
		await network.close()
		network = null
	}
})

/** Applies like the real store, except operations of the named records fail retriably. */
class StallingSyncStore extends MergeAwareSyncStore {
	readonly stalledRecords = new Set<string>()

	override async applyRemoteOperation(
		op: Parameters<MergeAwareSyncStore['applyRemoteOperation']>[0],
	): ReturnType<MergeAwareSyncStore['applyRemoteOperation']> {
		if (this.stalledRecords.has(op.recordId)) throw new Error('database is busy')
		return super.applyRemoteOperation(op)
	}

	override async applyDeliveryBatch<T>(
		fn: Parameters<MergeAwareSyncStore['applyDeliveryBatch']>[0],
	): ReturnType<MergeAwareSyncStore['applyDeliveryBatch']> {
		// A stalled batch is applied operation by operation, as it is in production.
		if (this.stalledRecords.size > 0) return null
		return super.applyDeliveryBatch<T>(fn as never)
	}
}

function devices(): [TestDevice, TestDevice] {
	const [writer, reader] = network?.devices ?? []
	if (!writer || !reader) throw new Error('the network has no devices')
	return [writer, reader]
}

/** The reading device online, through `store`. */
async function connect(reader: TestDevice, store: MergeAwareSyncStore): Promise<SyncEngine> {
	const pair = createServerTransportPair()
	const engine = new SyncEngine({
		transport: pair.client as unknown as SyncTransport,
		store,
		syncState: new StoreSyncStatePersistence(reader.store),
		config: { url: 'ws://test-network', schemaVersion: schema.version },
		emitter: reader.emitter,
	})
	engines.push(engine)
	network?.server.handleConnection(pair.server)
	await engine.start()
	return engine
}

/** A reload with no network: the engine loads what is stored and cannot connect. */
async function reloadOffline(reader: TestDevice): Promise<SyncEngine> {
	const { client } = createMemoryTransportPair()
	client.connect = async () => {
		throw new Error('offline')
	}
	const engine = new SyncEngine({
		transport: client,
		store: new MergeAwareSyncStore(reader.store, new MergeEngine(), reader.emitter),
		syncState: new StoreSyncStatePersistence(reader.store),
		config: { url: 'ws://test-network', schemaVersion: schema.version },
		emitter: reader.emitter,
	})
	engines.push(engine)
	await engine.start().catch(() => {})
	return engine
}

async function rows(device: TestDevice): Promise<number> {
	return (await device.getState('lessons')).length
}

describe('offline completion marks, end to end', () => {
	test('a fully delivered view is complete after a reload with no network', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [writer, reader] = devices()
		for (let i = 0; i < 12; i++) await writer.collection('lessons').insert({ title: `lesson ${i}` })
		await writer.sync()

		const live = await connect(
			reader,
			new MergeAwareSyncStore(reader.store, new MergeEngine(), reader.emitter),
		)
		await vi.waitFor(() => expect(live.getOfflineData().state).toBe('complete'), {
			timeout: 10_000,
		})
		expect(await rows(reader)).toBe(12)
		await live.stop()

		const reloaded = await reloadOffline(reader)
		expect(reloaded.getOfflineData()).toMatchObject({ state: 'complete', sessionLive: false })
	}, 30_000)

	test('a unit that stalls mid-way is never complete after a reload, until a later unit finishes', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [writer, reader] = devices()
		for (let i = 0; i < 10; i++) await writer.collection('lessons').insert({ title: `lesson ${i}` })
		await writer.sync()

		const first = await connect(
			reader,
			new MergeAwareSyncStore(reader.store, new MergeEngine(), reader.emitter),
		)
		await vi.waitFor(() => expect(first.getOfflineData().state).toBe('complete'), {
			timeout: 10_000,
		})
		await first.stop()
		expect((await reloadOffline(reader)).getOfflineData().state).toBe('complete')

		// The writer adds more; the reader's next session applies part of it and stalls.
		const added: string[] = []
		for (let i = 0; i < 6; i++) {
			const record = await writer.collection('lessons').insert({ title: `new ${i}` })
			added.push(record.id as string)
		}
		await writer.sync()
		const stalling = new StallingSyncStore(reader.store, new MergeEngine(), reader.emitter)
		stalling.stalledRecords.add(added[3] as string)
		const stalled = await connect(reader, stalling)
		await vi.waitFor(() => expect(stalled.getStatus().blockedFailure).not.toBeNull(), {
			timeout: 10_000,
		})
		const partial = await rows(reader)
		expect(partial).toBeGreaterThan(10)
		expect(partial).toBeLessThan(16)
		expect(stalled.getOfflineData()).toMatchObject({ blocked: true })
		expect(stalled.getOfflineData().state).not.toBe('complete')

		// The tab dies; every reload without a network, however many, reads incomplete.
		await stalled.destroy()
		expect((await reloadOffline(reader)).getOfflineData().state).toBe('incomplete')
		expect((await reloadOffline(reader)).getOfflineData().state).toBe('incomplete')

		// Back online with nothing stalling, the next unit finishes and the view is complete.
		const healed = await connect(
			reader,
			new MergeAwareSyncStore(reader.store, new MergeEngine(), reader.emitter),
		)
		await vi.waitFor(() => expect(healed.getOfflineData().state).toBe('complete'), {
			timeout: 10_000,
		})
		expect(await rows(reader)).toBe(16)
		await healed.stop()
		expect((await reloadOffline(reader)).getOfflineData().state).toBe('complete')
	}, 60_000)

	test('two readers on one server each hold their own mark', async () => {
		network = await createTestNetwork(schema, { devices: 3 })
		const [writer, readerA, readerB] = network.devices as [TestDevice, TestDevice, TestDevice]
		await writer.collection('lessons').insert({ title: 'one' })
		await writer.sync()

		const a = await connect(
			readerA,
			new MergeAwareSyncStore(readerA.store, new MergeEngine(), readerA.emitter),
		)
		await vi.waitFor(() => expect(a.getOfflineData().state).toBe('complete'), { timeout: 10_000 })
		// B never synced: its own database holds no mark, whatever A's holds.
		expect((await reloadOffline(readerB)).getOfflineData().state).toBe('incomplete')
		expect((await reloadOffline(readerA)).getOfflineData().state).toBe('complete')
	}, 30_000)
})

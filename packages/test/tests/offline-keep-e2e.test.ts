/**
 * Kept pins, end to end (offline-readiness design 4.3, A5): a device that follows one course
 * through a live query and pins another holds both, is `complete` offline only for the view
 * it actually fetched, and a pin added offline is not complete until the next session
 * delivers it.
 *
 * A real server, a writer device and a reading device (real Store on SQLite, the korajs
 * sync store and persistence, a real SyncEngine), with `createOfflineKeep` wired to that
 * engine and store as `createApp` wires it.
 */
import { defineSchema, t } from '@korajs/core'
import { MergeEngine } from '@korajs/merge'
import { createServerTransportPair } from '@korajs/server/internal'
import { SyncEngine, type SyncTransport } from '@korajs/sync'
import { createMemoryTransportPair } from '@korajs/sync/internal'
import {
	MergeAwareSyncStore,
	StoreSyncStatePersistence,
	createOfflineKeep,
	createTabCoordination,
} from 'korajs/testing'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { TestDevice, TestNetwork } from '../src/index'
import { createTestNetwork } from '../src/index'

const schema = defineSchema({
	version: 1,
	collections: { lessons: { fields: { title: t.string(), courseId: t.string() } } },
})

let network: TestNetwork | null = null
const engines: SyncEngine[] = []
const keeps: Array<{ dispose(): void }> = []

afterEach(async () => {
	for (const keep of keeps.splice(0)) keep.dispose()
	for (const engine of engines.splice(0)) await engine.destroy().catch(() => {})
	if (network) {
		await network.close()
		network = null
	}
})

const course = (courseId: string) => ({
	getDescriptor: () => ({ collection: 'lessons', where: { courseId } }),
})

/**
 * One session of the reading device: an engine that follows course A through a live query,
 * the pins read from (and kept in) the device's own database, then connected or not.
 */
async function session(reader: TestDevice, online: boolean) {
	let engine: SyncEngine
	if (online) {
		const pair = createServerTransportPair()
		engine = new SyncEngine({
			transport: pair.client as unknown as SyncTransport,
			store: new MergeAwareSyncStore(reader.store, new MergeEngine(), reader.emitter),
			syncState: new StoreSyncStatePersistence(reader.store),
			config: { url: 'ws://test-network', schemaVersion: schema.version },
			emitter: reader.emitter,
		})
		network?.server.handleConnection(pair.server)
	} else {
		const { client } = createMemoryTransportPair()
		client.connect = async () => {
			throw new Error('offline')
		}
		engine = new SyncEngine({
			transport: client,
			store: new MergeAwareSyncStore(reader.store, new MergeEngine(), reader.emitter),
			syncState: new StoreSyncStatePersistence(reader.store),
			config: { url: 'ws://test-network', schemaVersion: schema.version },
			emitter: reader.emitter,
		})
	}
	engines.push(engine)
	engine.registerQuerySubset({ collection: 'lessons', where: { courseId: 'A' } })
	const keep = createOfflineKeep({
		dbName: 'e2e',
		emitter: reader.emitter,
		persistence: { requestInBackground: () => {} },
		coordination: createTabCoordination(null, { dbName: 'e2e', locks: null, page: null }),
		runtime: {
			store: () => reader.store,
			engine: () => engine,
			blobStore: () => null,
			pull: async () => {},
			dataComplete: () => engine.getOfflineData().state === 'complete',
		},
	})
	keeps.push(keep)
	await keep.load()
	return { engine, keep }
}

async function titles(device: TestDevice, courseId: string): Promise<string[]> {
	const all = await device.getState('lessons')
	return all
		.filter((row) => row.courseId === courseId)
		.map((row) => String(row.title))
		.sort()
}

describe('kept pins, end to end', () => {
	test('a pinned course is delivered beside the followed one, and complete means both', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [writer, reader] = network.devices as [TestDevice, TestDevice]
		for (const courseId of ['A', 'B', 'C']) {
			for (let i = 0; i < 3; i++) {
				await writer.collection('lessons').insert({ title: `${courseId}${i}`, courseId })
			}
		}
		await writer.sync()

		// Session 1: pin course B before connecting, as createApp does with the stored pins.
		const first = await session(reader, true)
		const handle = await first.keep.keep(course('B'))
		await first.engine.start()
		await vi.waitFor(() => expect(first.engine.getOfflineData().state).toBe('complete'), {
			timeout: 10_000,
		})
		await handle.whenComplete()
		expect(await titles(reader, 'A')).toEqual(['A0', 'A1', 'A2'])
		expect(await titles(reader, 'B')).toEqual(['B0', 'B1', 'B2'])
		// Course C is neither followed nor kept: it was never fetched.
		expect(await titles(reader, 'C')).toEqual([])
		expect(handle.status()).toMatchObject({ complete: true, records: 3 })
		await first.engine.stop()

		// Session 2, no network: the pin is read back from the database and still complete.
		const second = await session(reader, false)
		await second.engine.start().catch(() => {})
		expect(second.keep.list().map((pin) => pin.collection)).toEqual(['lessons'])
		expect(second.engine.getOfflineData().state).toBe('complete')

		// A pin made offline cannot be complete: its records were never delivered.
		const late = await second.keep.keep(course('C'))
		expect(second.engine.getOfflineData().state).toBe('incomplete')
		expect(late.status().complete).toBe(false)
		await second.engine.stop()

		// Session 3, online: both pins are in the handshake and course C arrives.
		const third = await session(reader, true)
		await third.engine.start()
		await vi.waitFor(() => expect(third.engine.getOfflineData().state).toBe('complete'), {
			timeout: 10_000,
		})
		expect(await titles(reader, 'C')).toEqual(['C0', 'C1', 'C2'])
		await third.engine.stop()
	}, 60_000)

	test('releasing a pin takes its course out of the view; the data already fetched stays', async () => {
		network = await createTestNetwork(schema, { devices: 2 })
		const [writer, reader] = network.devices as [TestDevice, TestDevice]
		for (const courseId of ['A', 'B']) {
			await writer.collection('lessons').insert({ title: `${courseId}0`, courseId })
		}
		await writer.sync()

		const first = await session(reader, true)
		const handle = await first.keep.keep(course('B'))
		await first.engine.start()
		await vi.waitFor(() => expect(first.engine.getOfflineData().state).toBe('complete'), {
			timeout: 10_000,
		})
		await first.engine.stop()

		const second = await session(reader, false)
		await second.engine.start().catch(() => {})
		await second.keep.release(handle)
		expect(second.keep.list()).toEqual([])
		// Without the pin the view is course A alone, which the earlier mark covers.
		expect(second.engine.getActiveQuerySubsets()).toEqual([
			{ collection: 'lessons', where: { courseId: 'A' } },
		])
		expect(second.engine.getOfflineData().state).toBe('complete')
		expect(await titles(reader, 'B')).toEqual(['B0'])
	}, 60_000)
})

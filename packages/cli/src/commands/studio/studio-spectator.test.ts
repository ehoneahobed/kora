import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { MergeEngine } from '@korajs/merge'
import { MemoryServerStore, createKoraServer } from '@korajs/server'
import { Store } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import { SyncEngine, WebSocketTransport } from '@korajs/sync'
import {
	ApplyPipeline,
	MergeAwareSyncStore,
	StoreQueueStorage,
	StoreSyncStatePersistence,
} from 'korajs/testing'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { StudioDbReader } from './db-reader'
import { SpectatorManager } from './spectator-manager'

/**
 * Spectator contract, proven against the REAL stack end-to-end: a real
 * KoraSyncServer listening on a real port, a real client pushing operations
 * over the real WebSocket wire, and the spectator materializing a live
 * read-only replica that Studio's reader inspects.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		notes: {
			fields: {
				title: t.string(),
				pinned: t.boolean().default(false),
			},
		},
	},
})

const PORT = 43199

/** A minimal REAL Kora client (store + pipeline + sync engine over ws). */
async function createWsClient(dir: string, name: string) {
	const emitter = new SimpleEventEmitter()
	const adapter = new BetterSqlite3Adapter(join(dir, `${name}.db`))
	const store = new Store({ schema, adapter, emitter })
	await store.open()
	const mergeEngine = new MergeEngine()
	const pipeline = new ApplyPipeline({ store, mergeEngine, emitter })
	store.setLocalMutationHandler(pipeline)
	const engine = new SyncEngine({
		transport: new WebSocketTransport(),
		store: new MergeAwareSyncStore(store, mergeEngine, emitter),
		queueStorage: new StoreQueueStorage(adapter),
		syncState: new StoreSyncStatePersistence(store),
		config: { url: `ws://127.0.0.1:${PORT}`, schemaVersion: 1 },
		emitter,
	})
	// Push local ops as they happen (same wiring the app uses).
	emitter.on('operation:created', (event) => {
		void engine.pushOperation(event.operation).catch(() => {})
	})
	await engine.start()
	return {
		store,
		engine,
		close: async () => {
			await engine.stop().catch(() => {})
			await store.close().catch(() => {})
		},
	}
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
	const start = Date.now()
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error('Timed out waiting for condition')
		}
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
}

describe('Kora Studio Spectator (real ws server, real wire)', () => {
	let dir: string
	let server: ReturnType<typeof createKoraServer>
	let client: Awaited<ReturnType<typeof createWsClient>>
	let spectator: SpectatorManager
	let reader: StudioDbReader

	let serverStore: MemoryServerStore

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), 'kora-spectator-test-'))
		serverStore = new MemoryServerStore()
		await serverStore.setSchema(schema)
		server = createKoraServer({ store: serverStore, port: PORT, host: '127.0.0.1' })
		await server.start()

		// A real client creates data BEFORE the spectator ever connects — and we
		// wait until the server durably HOLDS it (push is async).
		client = await createWsClient(dir, 'client-A')
		await client.store.collection('notes').insert({ title: 'pre-existing note' })
		await waitFor(() => serverStore.getAllOperations().length >= 1)
	}, 30000)

	afterAll(async () => {
		await spectator?.close()
		await client?.close()
		await server?.stop()
		rmSync(dir, { recursive: true, force: true })
	})

	test('spectator receives the FULL history on connect (production time travel)', async () => {
		spectator = new SpectatorManager({ url: `ws://127.0.0.1:${PORT}`, schema })
		await spectator.start()

		await waitFor(() => spectator.status().connected)
		await waitFor(() => spectator.status().operationsReceived >= 1)

		reader = await StudioDbReader.open(spectator.dbPath)
		const { records } = reader.records('notes')
		expect(records.some((r) => r.fields.title === 'pre-existing note')).toBe(true)
	}, 20000)

	test('live operations stream into the replica as they happen', async () => {
		const created = await client.store.collection('notes').insert({ title: 'live insert' })
		await client.store.collection('notes').update(created.id, { pinned: true })

		await waitFor(() => {
			const record = reader.record('notes', created.id)
			return record !== null && record.fields.pinned === 1
		})

		// Per-field last writers and the op history are all inspectable, live.
		const record = reader.record('notes', created.id)
		expect(record?.fieldVersions.pinned).toBeDefined()
		const ops = reader.recordOperations('notes', created.id)
		expect(ops.map((o) => o.type)).toEqual(['update', 'insert'])
	}, 20000)

	test('the spectator is read-only by construction: no mutation surface exists', () => {
		// The manager exposes no insert/update/delete — this is a compile-time
		// guarantee; assert it at runtime for completeness.
		const surface = spectator as unknown as Record<string, unknown>
		expect(surface.insert).toBeUndefined()
		expect(surface.update).toBeUndefined()
		expect(surface.delete).toBeUndefined()
	})

	test('spectator reports status and buffers events', async () => {
		const status = spectator.status()
		expect(status.connected).toBe(true)
		expect(status.operationsReceived).toBeGreaterThanOrEqual(3)
		const types = new Set(spectator.recentEvents().map((e) => e.type))
		expect(types.has('sync:received')).toBe(true)
	})
})

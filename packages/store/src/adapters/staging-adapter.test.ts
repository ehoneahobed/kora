import { describe, expect, test } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { BetterSqlite3Adapter } from './better-sqlite3-adapter'
import { IndexedDbAdapter } from './indexeddb-adapter'
import { SqliteWasmAdapter } from './sqlite-wasm-adapter'
import { MockWorkerBridge } from './sqlite-wasm-mock-bridge'

describe('createStagingAdapter: which databases stage a first sync', () => {
	test('an in-memory main database has no staging database (a second memory database gains nothing)', async () => {
		const adapter = new SqliteWasmAdapter({ bridge: new MockWorkerBridge(), storage: 'memory' })
		await adapter.open(minimalSchema)
		expect(await adapter.createStagingAdapter()).toBeNull()
		await adapter.close()
	})

	test('an adapter with an injected bridge and no staging factory has none', async () => {
		const adapter = new SqliteWasmAdapter({ bridge: new MockWorkerBridge() })
		await adapter.open(minimalSchema)
		expect(await adapter.createStagingAdapter()).toBeNull()
		await adapter.close()
	})

	test('a durable browser database gets an independent in-memory database from the staging factory', async () => {
		const main = new MockWorkerBridge()
		let created = 0
		const adapter = new SqliteWasmAdapter({
			bridge: main,
			allowNonDurable: true,
			stagingBridgeFactory: () => {
				created += 1
				return new MockWorkerBridge()
			},
		})
		await adapter.open(minimalSchema)
		const staging = await adapter.createStagingAdapter()
		expect(staging).not.toBeNull()
		expect(created).toBe(1)
		await staging?.open(minimalSchema)
		await staging?.execute('INSERT INTO _kora_meta (key, value) VALUES (?, ?)', ['k', 'v'])
		const mainRows = await adapter.query<{ key: string }>(
			"SELECT key FROM _kora_meta WHERE key = 'k'",
		)
		expect(mainRows).toEqual([])
		await staging?.close()
		await adapter.close()
	})

	test('IndexedDB fallback and native SQLite behaviour: no staging for IndexedDB, opt-in for native', async () => {
		const indexed = new IndexedDbAdapter({ dbName: 'staging-fallback' })
		expect((indexed as { createStagingAdapter?: unknown }).createStagingAdapter).toBeUndefined()
		const native = new BetterSqlite3Adapter(':memory:')
		expect(native.prefersStaging).toBe(false)
		const scratch = await native.createStagingAdapter()
		expect(scratch).not.toBeNull()
		await scratch?.close()
	})
})

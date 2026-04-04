import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { Store } from '../../src/store/store'
import { minimalSchema } from '../fixtures/test-schema'

describe('Integration: Operation persistence', () => {
	let dbPath: string

	beforeEach(() => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kora-test-'))
		dbPath = path.join(tmpDir, 'test.db')
	})

	afterEach(() => {
		try {
			// Clean up temp files
			const dir = path.dirname(dbPath)
			fs.rmSync(dir, { recursive: true, force: true })
		} catch {
			// Ignore cleanup errors
		}
	})

	test('data persists across close and reopen', async () => {
		// Session 1: create records
		const adapter1 = new BetterSqlite3Adapter(dbPath)
		const store1 = new Store({ schema: minimalSchema, adapter: adapter1, nodeId: 'persist-node' })
		await store1.open()

		const todos1 = store1.collection('todos')
		const record = await todos1.insert({ title: 'Persistent' })
		await todos1.insert({ title: 'Also persistent' })

		const recordId = record.id
		await store1.close()

		// Session 2: verify data survived
		const adapter2 = new BetterSqlite3Adapter(dbPath)
		const store2 = new Store({ schema: minimalSchema, adapter: adapter2 })
		await store2.open()

		const todos2 = store2.collection('todos')
		const found = await todos2.findById(recordId)
		expect(found).not.toBeNull()
		expect(found?.title).toBe('Persistent')

		const all = await todos2.where({}).exec()
		expect(all).toHaveLength(2)

		await store2.close()
	})

	test('operations persist across close and reopen', async () => {
		// Session 1: create operations
		const adapter1 = new BetterSqlite3Adapter(dbPath)
		const store1 = new Store({ schema: minimalSchema, adapter: adapter1, nodeId: 'ops-node' })
		await store1.open()

		const todos1 = store1.collection('todos')
		await todos1.insert({ title: 'Op 1' })
		await todos1.insert({ title: 'Op 2' })
		await store1.close()

		// Session 2: verify operations survived
		const adapter2 = new BetterSqlite3Adapter(dbPath)
		const store2 = new Store({ schema: minimalSchema, adapter: adapter2 })
		await store2.open()

		const ops = await store2.getOperationRange('ops-node', 1, 2)
		expect(ops).toHaveLength(2)
		expect(ops[0]?.type).toBe('insert')
		expect(ops[1]?.type).toBe('insert')
		expect(ops[0]?.collection).toBe('todos')

		await store2.close()
	})

	test('version vector persists across close and reopen', async () => {
		// Session 1: create records to advance version vector
		const adapter1 = new BetterSqlite3Adapter(dbPath)
		const store1 = new Store({ schema: minimalSchema, adapter: adapter1, nodeId: 'vv-node' })
		await store1.open()

		const todos1 = store1.collection('todos')
		await todos1.insert({ title: 'VV 1' })
		await todos1.insert({ title: 'VV 2' })
		await todos1.insert({ title: 'VV 3' })

		const vv1 = store1.getVersionVector()
		expect(vv1.get('vv-node')).toBe(3)
		await store1.close()

		// Session 2: verify version vector survived
		const adapter2 = new BetterSqlite3Adapter(dbPath)
		const store2 = new Store({ schema: minimalSchema, adapter: adapter2 })
		await store2.open()

		const vv2 = store2.getVersionVector()
		expect(vv2.get('vv-node')).toBe(3)

		await store2.close()
	})

	test('nodeId persists across close and reopen', async () => {
		// Session 1: let store generate a nodeId
		const adapter1 = new BetterSqlite3Adapter(dbPath)
		const store1 = new Store({ schema: minimalSchema, adapter: adapter1, nodeId: 'fixed-node' })
		await store1.open()
		const nodeId = store1.getNodeId()
		expect(nodeId).toBe('fixed-node')
		await store1.close()

		// Session 2: should reload the same nodeId
		const adapter2 = new BetterSqlite3Adapter(dbPath)
		const store2 = new Store({ schema: minimalSchema, adapter: adapter2 })
		await store2.open()
		expect(store2.getNodeId()).toBe('fixed-node')
		await store2.close()
	})

	test('sequence number continues from where it left off', async () => {
		// Session 1: insert 3 records
		const adapter1 = new BetterSqlite3Adapter(dbPath)
		const store1 = new Store({ schema: minimalSchema, adapter: adapter1, nodeId: 'seq-node' })
		await store1.open()

		const todos1 = store1.collection('todos')
		await todos1.insert({ title: 'Seq 1' })
		await todos1.insert({ title: 'Seq 2' })
		await todos1.insert({ title: 'Seq 3' })
		await store1.close()

		// Session 2: insert more — should continue from seq 3
		const adapter2 = new BetterSqlite3Adapter(dbPath)
		const store2 = new Store({ schema: minimalSchema, adapter: adapter2 })
		await store2.open()

		const todos2 = store2.collection('todos')
		await todos2.insert({ title: 'Seq 4' })

		const ops = await store2.getOperationRange('seq-node', 4, 4)
		expect(ops).toHaveLength(1)
		expect(ops[0]?.sequenceNumber).toBe(4)

		await store2.close()
	})
})

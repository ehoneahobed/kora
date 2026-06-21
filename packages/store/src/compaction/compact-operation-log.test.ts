import { createVersionVector } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { minimalSchema } from '../../tests/fixtures/test-schema'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'
import { compactOperationLog, computeAckCompactionWatermark } from './compact-operation-log'

describe('compactOperationLog', () => {
	test('after-ack removes ops at or below server watermark', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		const store = new Store({ schema: minimalSchema, adapter, nodeId: 'compact-node' })
		await store.open()

		await store.collection('todos').insert({ title: 'One' })
		await store.collection('todos').insert({ title: 'Two' })
		const localVector = store.getVersionVector()
		const serverVector = createVersionVector()
		for (const [nodeId, seq] of localVector) {
			serverVector.set(nodeId, seq)
		}

		const before = await store.getOperationRange('compact-node', 1, 10)
		expect(before.length).toBe(2)

		const result = await store.compact({ mode: 'after-ack', serverVector })
		expect(result.deletedCount).toBe(2)

		const after = await store.getOperationRange('compact-node', 1, 10)
		expect(after.length).toBe(0)

		const rows = await store.collection('todos').where({}).exec()
		expect(rows.length).toBe(2)

		await store.close()
	})

	test('never mode deletes nothing', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		const store = new Store({ schema: minimalSchema, adapter, nodeId: 'never-node' })
		await store.open()
		await store.collection('todos').insert({ title: 'Keep' })

		const result = await store.compact({ mode: 'never' })
		expect(result.deletedCount).toBe(0)

		const ops = await store.getOperationRange('never-node', 1, 5)
		expect(ops.length).toBe(1)
		await store.close()
	})
})

describe('computeAckCompactionWatermark', () => {
	test('copies positive server sequences only', () => {
		const server = createVersionVector()
		server.set('a', 3)
		server.set('b', 0)
		const watermark = computeAckCompactionWatermark(server)
		expect(watermark.get('a')).toBe(3)
		expect(watermark.has('b')).toBe(false)
	})
})

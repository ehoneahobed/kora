import { HybridLogicalClock, createOperation, defineSchema, t } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { Store } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import { afterEach, describe, expect, test } from 'vitest'
import { wireLocalOperationBus } from './local-operation-bus'

/**
 * STORE-10: tabs sharing one database learn about remote operations another tab
 * applied, not only about local writes.
 */
const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('local operation bus', () => {
	const cleanups: Array<() => Promise<void> | void> = []
	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
	})

	test('a remote apply in one tab refreshes the other tab and advances its vector', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		const emitterA = new SimpleEventEmitter()
		const emitterB = new SimpleEventEmitter()
		const tabA = new Store({ schema, adapter, nodeId: 'shared', emitter: emitterA })
		const tabB = new Store({ schema, adapter, nodeId: 'shared', emitter: emitterB })
		await tabA.open()
		await tabB.open()
		const dbName = `bus-${Date.now()}-${Math.random()}`
		cleanups.push(wireLocalOperationBus(dbName, tabA, emitterA))
		cleanups.push(wireLocalOperationBus(dbName, tabB, emitterB))
		cleanups.push(() => tabA.close())

		let seen: unknown[] = []
		tabB
			.collection('todos')
			.where({})
			.subscribe((rows) => {
				seen = rows
			})
		await settle()

		const remote = await createOperation(
			{
				nodeId: 'server-peer',
				type: 'insert',
				collection: 'todos',
				recordId: 'r1',
				data: { title: 'from server' },
				previousData: null,
				sequenceNumber: 4,
				causalDeps: [],
				schemaVersion: 1,
			},
			new HybridLogicalClock('server-peer'),
		)
		expect(await tabA.applyRemoteOperation(remote)).toBe('applied')
		await settle()

		expect(seen).toHaveLength(1)
		expect(tabB.getVersionVector().get('server-peer')).toBe(4)
	})
})

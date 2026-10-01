import { HybridLogicalClock, createOperation, defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'
import type { KoraApp } from '../../src/types'

// STORE-14: after the public store.compact({ mode: 'after-ack' }) a stale
// concurrent remote update must not resurrect a record whose (newer) delete
// was compacted away. The server, which keeps the whole log, keeps it deleted.
const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

describe('STORE-14 compaction vs log re-fold', () => {
	let app: KoraApp
	afterEach(async () => {
		if (app) await app.close()
	})

	test('stale remote update after compaction keeps the record deleted', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready
		const store = app.getStore()
		const todos = (app as unknown as Record<string, any>).todos
		const rec = await todos.insert({ title: 'orig' })
		const [ins] = await store.getAllOperations()
		const t0 = ins!.timestamp.wallTime
		// Concurrent remote edit at t0+1 (authored before our delete).
		const remote = await createOperation(
			{
				nodeId: 'remote-node',
				type: 'update',
				collection: 'todos',
				recordId: rec.id,
				data: { title: 'remote' },
				previousData: { title: 'orig' },
				sequenceNumber: 1,
				causalDeps: [],
				schemaVersion: 1,
			},
			new HybridLogicalClock('remote-node', { now: () => t0 + 1 } as never),
		)
		while (Date.now() <= t0 + 2) {
			/* ensure local delete is strictly newer */
		}
		await todos.delete(rec.id)
		// Server acknowledged both local ops; compact.
		await store.compact({
			mode: 'after-ack',
			serverVector: new Map([[store.getNodeId(), 2]]),
		} as never)

		const pipeline = (store as unknown as { localMutationHandler: any }).localMutationHandler
		await pipeline.applyRemote(remote)
		expect(await todos.findById(rec.id)).toBeNull()
	})
})

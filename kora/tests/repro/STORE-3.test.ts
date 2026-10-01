import { HybridLogicalClock, createOperation, defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'
import type { KoraApp } from '../../src/types'

// STORE-3: writes made through app.transaction must participate in per-field
// LWW exactly like app.<collection>.update/insert, so a concurrent remote op
// with an OLDER HLC never overwrites them locally (the server keeps the local
// value -> permanent divergence otherwise).
const schema = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string(), count: t.number().default(0) } },
	},
})

const spinUntil = (wall: number) => {
	while (Date.now() <= wall) {
		/* spin: guarantees local HLC wall time > wall */
	}
}

function remoteClockAt(wall: number) {
	return new HybridLogicalClock('remote-node', { now: () => wall } as never)
}

async function applyRemote(app: KoraApp, op: Operation) {
	// The same ApplyPipeline the SyncEngine uses for inbound ops.
	const pipeline = (app.getStore() as unknown as { localMutationHandler: any }).localMutationHandler
	return pipeline.applyRemote(op)
}

describe('STORE-3 transactional writes vs per-field LWW', () => {
	let app: KoraApp
	afterEach(async () => {
		if (app) await app.close()
	})

	test('older remote update does not overwrite a newer app.transaction update', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready
		const todos = (app as unknown as Record<string, any>).todos
		const rec = await todos.insert({ title: 'orig' })
		const [insertOp] = await app.getStore().getAllOperations()
		const t0 = insertOp!.timestamp.wallTime

		// Remote device edits title at t0+1 (concurrent, not yet delivered).
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
			remoteClockAt(t0 + 1),
		)
		spinUntil(t0 + 2)
		// Local edit inside a transaction at >= t0+3: strictly newer than remote.
		await app.transaction(async (tx) => {
			await tx.todos!.update(rec.id, { title: 'local' })
		})
		await applyRemote(app, remote)
		expect((await todos.findById(rec.id)).title).toBe('local')
	})

	test('remote update to an untouched field of a tx-inserted row is applied', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready
		const todos = (app as unknown as Record<string, any>).todos
		let id = ''
		const [ins] = await app.transaction(async (tx) => {
			id = (await tx.todos!.insert({ title: 'orig' })).id
		})
		const t0 = ins!.timestamp.wallTime
		const mk = (data: Record<string, unknown>, prev: Record<string, unknown>, wall: number, seq: number) =>
			createOperation(
				{
					nodeId: 'remote-node',
					type: 'update',
					collection: 'todos',
					recordId: id,
					data,
					previousData: prev,
					sequenceNumber: seq,
					causalDeps: [],
					schemaVersion: 1,
				},
				remoteClockAt(wall),
			)
		const countOp = await mk({ count: 5 }, { count: 0 }, t0 + 1, 1) // older
		const titleOp = await mk({ title: 'newer' }, { title: 'orig' }, t0 + 2, 2) // newer
		await applyRemote(app, titleOp)
		await applyRemote(app, countOp)
		const row = await todos.findById(id)
		// Server fold (and any device that saw countOp first) has count=5.
		expect(row.count).toBe(5)
		expect(row.title).toBe('newer')
	})
})

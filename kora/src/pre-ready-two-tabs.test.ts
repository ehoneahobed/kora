import 'fake-indexeddb/auto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import { Store } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PreReadyWriteQueue } from './pre-ready-writes'
import { openWriteJournal } from './write-journal'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

const LATER = (): number => Date.now() + 10 * 60 * 1000
let dir: string
let counter = 0
const stores: Store[] = []

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'kora-two-tabs-'))
})

afterEach(async () => {
	for (const store of stores.splice(0)) await store.close()
	rmSync(dir, { recursive: true, force: true })
})

/** One tab: its own SQLite connection to the shared database file, and its own queue. */
async function tab(file: string, db: string): Promise<{ queue: PreReadyWriteQueue; store: Store }> {
	// Tabs of one device share the node id.
	const store = new Store({ schema, adapter: new BetterSqlite3Adapter(file), nodeId: 'device-1' })
	await store.open()
	stores.push(store)
	const queue = new PreReadyWriteQueue({
		dbName: db,
		locks: null,
		session: `tab-${++counter}`,
		now: LATER,
		emit: () => {},
		resolveOwner: async () => 'bob',
		namespacedByUser: true,
		openedFor: () => 'bob',
	})
	await queue.apply(store)
	await queue.settled()
	await queue.noteSignedInUser('bob')
	return { queue, store }
}

describe('two tabs assign the same held writes, the second one late (real SQLite, two connections)', () => {
	it('every write lands exactly once, nobody fails, the journal is empty', async () => {
		const db = `two-tabs-${Date.now()}`
		const file = join(dir, 'app.db')
		const journal = openWriteJournal(db)
		if (!journal) throw new Error('IndexedDB should be available in this test')
		for (let i = 1; i <= 6; i++) {
			await journal.append({
				opKey: `held-${i}`,
				session: 'old',
				owner: null,
				ownerPending: true,
				at: Date.now(),
				writtenAt: 1000 + i,
				collection: 'todos',
				kind: 'insert',
				args: [{ title: `t${i}` }],
				recordId: `rec-${i}`,
			})
		}
		journal.close()

		const a = await tab(file, db)
		const b = await tab(file, db)
		expect(a.queue.heldNodes).toHaveLength(1)

		// Tab B read the held entries first and is about to apply them; tab A (its own SQLite
		// connection) assigns all of them in between. Two connections on one thread cannot
		// contend for the write lock (the driver is synchronous), so the interleaving is gated
		// rather than raced: B's first write waits until A is done.
		let release: () => void = () => {}
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const real = b.store.collection.bind(b.store)
		b.store.collection = ((name: string) => {
			const target = real(name as 'todos')
			return new Proxy(target, {
				get(obj, prop, receiver) {
					const value = Reflect.get(obj, prop, receiver)
					if (prop !== 'insert' || typeof value !== 'function') return value
					return async (...args: unknown[]) => {
						await gate
						return (value as (...a: unknown[]) => Promise<unknown>).apply(obj, args)
					}
				},
			})
		}) as typeof b.store.collection

		const second = b.queue.assignHeld('journal:unassigned', 'current-user')
		await a.queue.assignHeld('journal:unassigned', 'current-user')
		release()
		await expect(second).resolves.toBeUndefined()

		const rows = await a.store.collection('todos').where({}).exec()
		expect(rows.map((r) => (r as { id: string }).id).sort()).toEqual(
			[1, 2, 3, 4, 5, 6].map((i) => `rec-${i}`),
		)
		const log = await a.store.getOperationsForRecord('todos', 'rec-1')
		expect(log.filter((op) => op.type === 'insert')).toHaveLength(1)

		const left = openWriteJournal(db)
		expect(await left?.list()).toEqual([])
		left?.close()
	})
})

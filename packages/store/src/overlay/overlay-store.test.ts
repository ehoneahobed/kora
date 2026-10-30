import { defineSchema, t } from '@korajs/core'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { Store } from '../store/store'
import type { CollectionRecord } from '../types'
import { PendingWrites } from './pending-writes'
import { GatedAdapter, quiesce } from './test-support'
import { installWriteOverlay } from './write-overlay'

/**
 * The patched subscription path end to end (instant-UI S3): a real Store on a real
 * database, commits held at a gate by the test. The overlay is installed here only; with
 * none installed the store behaves as it always did (the rest of the suite).
 */
const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: { title: t.string(), done: t.boolean().default(false), rank: t.number().default(0) },
		},
	},
})

/** Turn the event loop until `done()` (bounded, no timers): a commit and its rollback take a few turns. */
async function until(done: () => boolean): Promise<void> {
	for (let i = 0; i < 50 && !done(); i++) await quiesce()
}

describe('patched subscriptions through the Collection API', () => {
	let store: Store
	let adapter: GatedAdapter
	let registry: PendingWrites
	let seen: CollectionRecord[][]

	const titles = (rows: readonly CollectionRecord[] | undefined) => (rows ?? []).map((r) => r.title)

	beforeEach(async () => {
		adapter = new GatedAdapter(':memory:')
		store = new Store({ schema, adapter, nodeId: 'overlay-store-node' })
		await store.open()
		registry = new PendingWrites()
		installWriteOverlay({ registry, readRecord: async () => null })
		seen = []
		store
			.collection('todos')
			.where({ done: false })
			.orderBy('rank', 'asc')
			.orderBy('id', 'asc')
			.subscribe((rows) => seen.push([...rows]))
		await quiesce()
		seen.length = 0
		adapter.gating = true
	})

	afterEach(async () => {
		installWriteOverlay(null)
		adapter.autoRelease = true
		for (const gate of adapter.gates.splice(0)) gate.release()
		await store.close()
	})

	test('a write is shown before its commit and equals the stored row after it', async () => {
		const todos = store.collection('todos')
		const write = todos.insert({ title: 'first', rank: 2 })
		await quiesce()
		expect(adapter.gates).toHaveLength(1) // the commit has not happened
		expect(titles(seen.at(-1))).toEqual(['first'])
		const shown = seen.at(-1)?.[0]

		adapter.gates.shift()?.release()
		const stored = await write
		await until(() => registry.list().length === 0)
		// Same id: a React key never changes between pending and stored.
		expect(shown?.id).toBe(stored.id)
		expect(registry.list()).toEqual([])
		expect(seen.at(-1)).toEqual(await todos.where({ done: false }).exec())
	})

	test('insert, update, update without awaiting: each step shows at once, in order', async () => {
		const todos = store.collection('todos')
		const first = todos.insert({ title: 'draft', rank: 5 })
		await quiesce()
		const id = registry.list()[0]?.recordId ?? ''
		const second = todos.update(id, { title: 'draft 2' })
		const third = todos.update(id, { rank: 1 })
		const other = todos.insert({ title: 'other', rank: 3 })
		await quiesce()
		expect(titles(seen.at(-1))).toEqual(['draft 2', 'other'])
		expect(adapter.gates).toHaveLength(4)

		adapter.autoRelease = true
		for (const gate of adapter.gates.splice(0)) gate.release()
		await Promise.all([first, second, third, other])
		await until(() => registry.list().length === 0)
		expect(registry.list()).toEqual([])
		expect(seen.at(-1)).toEqual(await todos.where({ done: false }).orderBy('rank').exec())
	})

	test('a failed insert takes its dependent updates with it; the list returns to the base', async () => {
		const todos = store.collection('todos')
		const base = await (async () => {
			adapter.gating = false
			const row = await todos.insert({ title: 'kept', rank: 9 })
			adapter.gating = true
			await quiesce()
			registry.settleCollection('todos', registry.epoch)
			return row
		})()
		seen.length = 0

		const insert = todos.insert({ title: 'doomed', rank: 1 })
		await quiesce()
		const id = registry.list().find((entry) => entry.kind === 'insert')?.recordId ?? ''
		const update = todos.update(id, { title: 'doomed 2' })
		await quiesce()
		expect(titles(seen.at(-1))).toEqual(['doomed 2', 'kept'])

		const results = Promise.allSettled([insert, update])
		adapter.gates.shift()?.fail() // the insert's commit fails
		await quiesce()
		await until(() => registry.list().length === 0)
		expect(titles(seen.at(-1))).toEqual(['kept']) // dependents removed with it
		adapter.autoRelease = true
		for (const gate of adapter.gates.splice(0)) gate.release()
		const [first, second] = await results
		expect(first.status).toBe('rejected')
		expect(second.status).toBe('rejected') // the record never existed
		await until(() => registry.list().length === 0)
		expect(registry.list()).toEqual([])
		expect(seen.at(-1)).toEqual(await todos.where({ done: false }).exec())
		expect(seen.at(-1)?.map((row) => row.id)).toEqual([base.id])
	})

	test('a row leaving the query is removed at once and stays out after the commit', async () => {
		const todos = store.collection('todos')
		adapter.gating = false
		const row = await todos.insert({ title: 'task', rank: 1 })
		adapter.gating = true
		await quiesce()
		expect(titles(seen.at(-1))).toEqual(['task'])
		const write = todos.update(row.id, { done: true })
		await quiesce()
		expect(seen.at(-1)).toEqual([])
		adapter.gates.shift()?.release()
		await write
		await until(() => registry.list().length === 0)
		expect(seen.at(-1)).toEqual([])
		expect(await todos.where({ done: false }).exec()).toEqual([])
	})
})

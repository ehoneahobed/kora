import { defineSchema, op, t } from '@korajs/core'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'

/**
 * An update whose values are already the record's writes nothing. Left alone, an autosave
 * that re-saves the same form hundreds of times produced a log in which 975 of 983 updates
 * changed nothing, and a new device downloaded and applied every one of them.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		forms: {
			fields: {
				title: t.string(),
				note: t.string().optional(),
				fields: t.array(t.object({ id: t.string(), label: t.string() })).default([]),
				n: t.number().default(0),
				tags: t.array(t.string()).default([]),
			},
		},
	},
})

describe('an update that changes nothing', () => {
	let store: Store
	beforeEach(async () => {
		store = new Store({
			schema,
			adapter: new BetterSqlite3Adapter(':memory:'),
			nodeId: 'unchanged-node',
		})
		await store.open()
	})
	afterEach(async () => {
		await store.close()
	})

	async function operationCount(): Promise<number> {
		return (await store.getAllOperations()).length
	}

	test('writes no operation and leaves the record as it was', async () => {
		const form = await store.collection('forms').insert({ title: 'a' })
		const before = await operationCount()
		const result = await store.collection('forms').update(form.id, { title: 'a' })
		expect(await operationCount()).toBe(before)
		expect(result.title).toBe('a')
		const read = await store.collection('forms').findById(form.id)
		expect(read?.updatedAt).toBe(form.updatedAt)
	})

	test('an array or object value equal to the stored one writes nothing', async () => {
		const fields = [{ id: 'f1', label: 'Name' }]
		const form = await store.collection('forms').insert({ title: 'a', fields })
		const before = await operationCount()
		await store.collection('forms').update(form.id, { fields: [{ label: 'Name', id: 'f1' }] })
		expect(await operationCount()).toBe(before)
		await store.collection('forms').update(form.id, { fields: [{ id: 'f1', label: 'Other' }] })
		expect(await operationCount()).toBe(before + 1)
	})

	test('a mixed update writes only the fields that changed', async () => {
		const form = await store.collection('forms').insert({ title: 'a', n: 1 })
		await store.collection('forms').update(form.id, { title: 'a', n: 2 })
		const last = (await store.getAllOperations()).at(-1)
		expect(last?.type).toBe('update')
		expect(last?.data).toEqual({ n: 2 })
		expect(last?.previousData).toEqual({ n: 1 })
	})

	test('an atomic op is always applied, even one that adds zero', async () => {
		const form = await store.collection('forms').insert({ title: 'a', n: 1 })
		const before = await operationCount()
		await store.collection('forms').update(form.id, { n: op.increment(1) })
		expect(await operationCount()).toBe(before + 1)
		expect((await store.collection('forms').findById(form.id))?.n).toBe(2)
	})

	test('the same value written twice in a row makes one operation', async () => {
		const form = await store.collection('forms').insert({ title: 'a' })
		const before = await operationCount()
		await store.collection('forms').update(form.id, { title: 'b' })
		await store.collection('forms').update(form.id, { title: 'b' })
		await store.collection('forms').update(form.id, { title: 'b' })
		expect(await operationCount()).toBe(before + 1)
	})

	test('inside a transaction, an unchanged update writes nothing either', async () => {
		const form = await store.collection('forms').insert({ title: 'a' })
		const before = await operationCount()
		await store.transaction(async (tx) => {
			await tx.collection('forms').update(form.id, { title: 'a' })
		})
		expect(await operationCount()).toBe(before)
	})
})

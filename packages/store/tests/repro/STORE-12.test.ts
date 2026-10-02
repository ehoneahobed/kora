import { defineSchema, t } from '@korajs/core'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { Store } from '../../src/store/store'

// STORE-12: subscriptions must not re-notify when results are unchanged
// (structured fields), and query failures must not become unhandled rejections.
const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				done: t.boolean().default(false),
				tags: t.array(t.string()).default([]),
			},
		},
	},
})
const ticks = async () => {
	for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('STORE-12 subscription diffing and errors', () => {
	let store: Store
	beforeEach(async () => {
		store = new Store({ schema, adapter: new BetterSqlite3Adapter(':memory:'), nodeId: 'n' })
		await store.open()
	})
	afterEach(async () => {
		await store.close()
	})

	test('unchanged result with an array field does not re-notify', async () => {
		const todos = store.collection('todos')
		await todos.insert({ title: 'a', tags: ['x'] })
		let calls = 0
		todos.where({ done: false }).subscribe(() => {
			calls++
		})
		await ticks()
		expect(calls).toBe(1)
		await todos.insert({ title: 'b', done: true }) // not in the result set
		await ticks()
		expect(calls).toBe(1)
	})

	test('a failing subscription query does not produce an unhandled rejection', async () => {
		const unhandled: unknown[] = []
		const onUnhandled = (e: unknown) => unhandled.push(e)
		process.on('unhandledRejection', onUnhandled)
		try {
			store
				.collection('todos')
				.where({})
				.orderBy('createdAt' as never)
				.subscribe(() => {})
			await ticks()
		} finally {
			process.off('unhandledRejection', onUnhandled)
		}
		expect(unhandled).toEqual([])
	})
})

import { defineSchema, op, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'
import type { KoraApp } from '../../src/types'

// STORE-9: concurrent local atomic increments must all take effect.
const schema = defineSchema({
	version: 1,
	collections: { counters: { fields: { n: t.number().default(0) } } },
})

describe('STORE-9 concurrent local increments', () => {
	let app: KoraApp
	afterEach(async () => {
		if (app) await app.close()
	})

	test('ten concurrent op.increment(1) calls yield n = 10', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready
		const counters = (app as unknown as Record<string, any>).counters
		const c = await counters.insert({ n: 0 })
		await Promise.all(
			Array.from({ length: 10 }, () => counters.update(c.id, { n: op.increment(1) })),
		)
		expect((await counters.findById(c.id)).n).toBe(10)
	})

	test('concurrent increments inside app.transaction also compose', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready
		const counters = (app as unknown as Record<string, any>).counters
		const c = await counters.insert({ n: 0 })
		await Promise.all(
			Array.from({ length: 5 }, () =>
				app.transaction(async (tx) => {
					await tx.counters!.update(c.id, { n: op.increment(1) })
				}),
			),
		)
		expect((await counters.findById(c.id)).n).toBe(5)
	})
})

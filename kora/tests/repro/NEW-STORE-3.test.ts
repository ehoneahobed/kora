import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'
import type { KoraApp } from '../../src/types'

// NEW-STORE-3: field-level t.enum(...).transitions() (docs/guide/state-machines.md
// "simplest approach") must be enforced on local updates.
const schema = defineSchema({
	version: 1,
	collections: {
		orders: {
			fields: {
				status: t
					.enum(['draft', 'submitted', 'delivered'])
					.default('draft')
					.transitions({ draft: ['submitted'], submitted: ['delivered'], delivered: [] }),
			},
		},
	},
})

describe('NEW-STORE-3 field-level transitions', () => {
	let app: KoraApp
	afterEach(async () => {
		if (app) await app.close()
	})

	test('control: direct update does not apply draft -> delivered', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready
		const orders = (app as unknown as Record<string, any>).orders
		const o = await orders.insert({})
		await orders.update(o.id, { status: 'delivered' }).catch(() => {})
		expect((await orders.findById(o.id)).status).toBe('draft')
	})

	test('transactional update does not apply draft -> delivered', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready
		const orders = (app as unknown as Record<string, any>).orders
		const o = await orders.insert({})
		await app
			.transaction(async (tx) => {
				await tx.orders!.update(o.id, { status: 'delivered' })
			})
			.catch(() => {})
		expect((await orders.findById(o.id)).status).toBe('draft')
	})
})

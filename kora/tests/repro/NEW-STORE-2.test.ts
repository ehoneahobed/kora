import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'
import type { KoraApp } from '../../src/types'

// NEW-STORE-2: state-machine transitions (docs/guide/state-machines.md) must be
// enforced for updates made inside app.transaction / app.mutation too.
const schema = defineSchema({
	version: 1,
	collections: {
		orders: {
			fields: {
				status: t.enum(['draft', 'submitted', 'delivered']).default('draft'),
			},
			stateMachine: {
				field: 'status',
				transitions: { draft: ['submitted'], submitted: ['delivered'], delivered: [] },
				onInvalidTransition: 'reject',
			},
		},
	},
})

describe('NEW-STORE-2 state machine in transactions', () => {
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

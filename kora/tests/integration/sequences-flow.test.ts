import { defineSchema, t } from '@korajs/core'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'
import type { KoraApp } from '../../src/types'

const schema = defineSchema({
	version: 1,
	collections: {
		orders: {
			fields: {
				orderNumber: t.string(),
				total: t.number(),
			},
		},
	},
})

describe('Sequences via createApp', () => {
	let app: KoraApp

	beforeEach(async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
		})
		await app.ready
	})

	afterEach(async () => {
		await app.close()
	})

	test('app.sequences.next() generates formatted values', async () => {
		const v1 = await app.sequences.next('order')
		const v2 = await app.sequences.next('order')

		expect(v1).toBe('order-0001')
		expect(v2).toBe('order-0002')
	})

	test('app.sequences.next() with custom format', async () => {
		const val = await app.sequences.next('receipt', {
			format: 'REC-{seq:6}',
		})
		expect(val).toBe('REC-000001')
	})

	test('app.sequences.next() with scope', async () => {
		const a = await app.sequences.next('receipt', { scope: 'store-A' })
		const b = await app.sequences.next('receipt', { scope: 'store-B' })
		const a2 = await app.sequences.next('receipt', { scope: 'store-A' })

		expect(a).toBe('receipt-0001')
		expect(b).toBe('receipt-0001')
		expect(a2).toBe('receipt-0002')
	})

	test('app.sequences.current() returns 0 for new', async () => {
		const val = await app.sequences.current('unused')
		expect(val).toBe(0)
	})

	test('app.sequences.current() returns counter after next()', async () => {
		await app.sequences.next('order')
		await app.sequences.next('order')
		const val = await app.sequences.current('order')
		expect(val).toBe(2)
	})

	test('app.sequences.reset() resets counter', async () => {
		await app.sequences.next('order')
		await app.sequences.next('order')
		await app.sequences.reset('order')

		const val = await app.sequences.next('order')
		expect(val).toBe('order-0001')
	})

	test('sequences work alongside CRUD operations', async () => {
		const orderNo = await app.sequences.next('order', {
			format: 'ORD-{seq:4}',
		})

		const order = await (app as Record<string, unknown>).orders.insert({
			orderNumber: orderNo,
			total: 99.99,
		})

		expect(order.orderNumber).toBe('ORD-0001')
		expect(order.total).toBe(99.99)
	})

	test('sequences work inside transactions', async () => {
		const orderNo = await app.sequences.next('order', {
			format: 'ORD-{seq:4}',
		})

		await app.transaction(async (tx) => {
			await tx.orders.insert({
				orderNumber: orderNo,
				total: 50,
			})
		})

		const found = await (app as Record<string, unknown>).orders.where({}).exec()
		expect(found).toHaveLength(1)
		expect(found[0].orderNumber).toBe('ORD-0001')
	})
})

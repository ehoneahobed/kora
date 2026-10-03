import { OperationTooLargeError, SchemaValidationError, defineSchema, op, t } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'

/**
 * The local write path enforces the one value domain (RT-86, RT-87): a write the server
 * would refuse is refused here, before anything is written.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		notes: {
			fields: {
				title: t.string(),
				body: t.string().optional(),
				due: t.timestamp().optional(),
				count: t.number().optional(),
			},
		},
	},
}) as unknown as SchemaDefinition

let store: Store | null = null
afterEach(async () => {
	await store?.close()
	store = null
})

async function open(maxOperationBytes?: number): Promise<Store> {
	store = new Store({
		schema,
		adapter: new BetterSqlite3Adapter(':memory:'),
		nodeId: 'dev',
		...(maxOperationBytes !== undefined ? { maxOperationBytes } : {}),
	})
	await store.open()
	return store
}

describe('local value domain (RT-86, RT-87)', () => {
	test('an operation over maxOperationBytes is refused with nothing written', async () => {
		const s = await open(8 * 1024)
		const notes = s.collection('notes')
		await expect(
			notes.insert({ title: 'big', body: 'x'.repeat(10 * 1024) }),
		).rejects.toBeInstanceOf(OperationTooLargeError)
		const small = await notes.insert({ title: 'small' })
		await expect(notes.update(String(small.id), { body: 'y'.repeat(10 * 1024) })).rejects.toThrow(
			/maxOperationBytes/,
		)
		expect(await notes.findById(String(small.id))).toMatchObject({ title: 'small' })
		expect(await s.getAllOperations()).toHaveLength(1)
	})

	test('the default limit is the server default (256 KiB)', async () => {
		const s = await open()
		await expect(
			s.collection('notes').insert({ title: 'big', body: 'x'.repeat(300 * 1024) }),
		).rejects.toBeInstanceOf(OperationTooLargeError)
		await s.collection('notes').insert({ title: 'fits', body: 'x'.repeat(200 * 1024) })
	})

	test('an atomic op whose result leaves the domain is refused', async () => {
		const s = await open()
		const notes = s.collection('notes')
		const row = await notes.insert({ title: 'a', due: 1000, count: 1e308 })
		const id = String(row.id)
		await expect(notes.update(id, { due: op.increment(0.5) })).rejects.toBeInstanceOf(
			SchemaValidationError,
		)
		await expect(notes.update(id, { count: op.increment(1e308) })).rejects.toThrow(/finite/)
		expect(await notes.findById(id)).toMatchObject({ due: 1000, count: 1e308 })
	})
})

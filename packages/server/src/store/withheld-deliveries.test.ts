import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { describe, expect, test } from 'vitest'
import { MemoryServerStore } from './memory-server-store'
import { PostgresServerStore } from './postgres-server-store'
import type { ServerStore } from './server-store'
import { SqliteServerStore } from './sqlite-server-store'

/**
 * Withheld-delivery marks (RT-115): every store keeps the same per-device set, and ids with
 * separators, quotes or a shared prefix never collide.
 */
const PG_URL = process.env.KORA_PG_TEST_URL
const stores: Array<[string, () => Promise<{ store: ServerStore; done: () => Promise<void> }>]> = [
	['memory', async () => ({ store: new MemoryServerStore('s'), done: async () => {} })],
	[
		'sqlite',
		async () => ({
			store: new SqliteServerStore(drizzle(new Database(':memory:')), 's'),
			done: async () => {},
		}),
	],
]
if (PG_URL) {
	stores.push([
		'postgres',
		async () => {
			const name = `kora_withheld_${process.pid}_${Math.floor(Math.random() * 1e9)}`
			const admin = postgres(PG_URL, { max: 1 })
			await admin.unsafe(`CREATE SCHEMA ${name}`)
			await admin.end()
			const client = postgres(PG_URL, { max: 2, connection: { search_path: name } })
			return {
				store: new PostgresServerStore(drizzlePg(client), 's'),
				done: async () => {
					await client.end()
					const drop = postgres(PG_URL, { max: 1 })
					await drop.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
					await drop.end()
				},
			}
		},
	])
}

describe.each(stores)('withheld deliveries (%s)', (_name, make) => {
	test('marks are per device, idempotent, listed, and cleared one record at a time', async () => {
		const { store, done } = await make()
		try {
			await store.markDeliveryWithheld?.('node-a', 'comments', 'c1')
			await store.markDeliveryWithheld?.('node-a', 'comments', 'c1')
			await store.markDeliveryWithheld?.('node-a', 'notes', 'n"1,:x')
			await store.markDeliveryWithheld?.('node-ab', 'comments', 'c9')
			await store.markDeliveryWithheld?.('node-b', 'comments', 'c1')
			const sorted = async (node: string) =>
				((await store.getDeliveryWithheld?.(node)) ?? []).sort((x, y) =>
					`${x.collection}/${x.recordId}`.localeCompare(`${y.collection}/${y.recordId}`),
				)
			expect(await sorted('node-a')).toEqual([
				{ collection: 'comments', recordId: 'c1' },
				{ collection: 'notes', recordId: 'n"1,:x' },
			])
			expect(await sorted('node-ab')).toEqual([{ collection: 'comments', recordId: 'c9' }])
			await store.clearDeliveryWithheld?.('node-a', 'comments', 'c1')
			expect(await sorted('node-a')).toEqual([{ collection: 'notes', recordId: 'n"1,:x' }])
			expect(await sorted('node-b')).toEqual([{ collection: 'comments', recordId: 'c1' }])
			expect(await sorted('node-unknown')).toEqual([])
		} finally {
			await store.close()
			await done()
		}
	})
})

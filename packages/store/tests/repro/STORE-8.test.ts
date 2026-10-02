import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { minimalSchema } from '../fixtures/test-schema'

// STORE-8: adapter.execute()/query() must not run inside another caller's open
// transaction (they bypass the adapter mutex today).
const ins =
	'INSERT INTO todos (id, title, completed, _created_at, _updated_at) VALUES (?, ?, ?, ?, ?)'

describe('STORE-8 execute/query isolation from open transactions', () => {
	let adapter: BetterSqlite3Adapter
	beforeEach(async () => {
		adapter = new BetterSqlite3Adapter(':memory:')
		await adapter.open(minimalSchema)
	})
	afterEach(async () => {
		await adapter.close()
	})

	test('a non-transactional write is not lost when a concurrent transaction rolls back', async () => {
		let midTx!: () => void
		const reached = new Promise<void>((r) => {
			midTx = r
		})
		let resume!: () => void
		const gate = new Promise<void>((r) => {
			resume = r
		})
		const tx = adapter
			.transaction(async (t) => {
				await t.execute(ins, ['tx-row', 'tx', 0, 1, 1])
				midTx()
				await gate
				throw new Error('optimistic lock / validation failure')
			})
			.catch(() => {})
		await reached
		const independent = adapter.execute(ins, ['independent', 'x', 0, 1, 1])
		resume()
		await Promise.all([tx, independent])
		const rows = await adapter.query<{ id: string }>('SELECT id FROM todos')
		expect(rows.map((r) => r.id)).toEqual(['independent'])
	})

	test('a reader never observes uncommitted rows of another transaction', async () => {
		let midTx!: () => void
		const reached = new Promise<void>((r) => {
			midTx = r
		})
		let resume!: () => void
		const gate = new Promise<void>((r) => {
			resume = r
		})
		const tx = adapter
			.transaction(async (t) => {
				await t.execute(ins, ['ghost', 'g', 0, 1, 1])
				midTx()
				await gate
				throw new Error('rollback')
			})
			.catch(() => {})
		await reached
		// The read is issued while the transaction is open. It must not observe the
		// uncommitted row; with the fix it waits for the transaction to settle (one
		// connection has no separate snapshot), so it is awaited after the gate opens.
		const seenPromise = adapter.query<{ id: string }>('SELECT id FROM todos')
		await new Promise((r) => setTimeout(r, 10))
		resume()
		await tx
		const seen = await seenPromise
		expect(seen).toEqual([])
	})
})

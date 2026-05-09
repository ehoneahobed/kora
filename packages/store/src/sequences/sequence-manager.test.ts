import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'
import { SequenceManager } from './sequence-manager'

// Minimal schema for testing (sequences don't need collections)
const minimalSchema = {
	version: 1,
	collections: {
		items: {
			fields: {
				name: {
					kind: 'string' as const,
					required: true,
					defaultValue: undefined,
					auto: false,
					enumValues: null,
					itemKind: null,
					mergeStrategy: null,
				},
			},
			indexes: [],
			constraints: [],
			resolvers: {},
		},
	},
	relations: {},
}

describe('SequenceManager', () => {
	let store: Store
	let adapter: BetterSqlite3Adapter
	let mgr: SequenceManager

	beforeEach(async () => {
		adapter = new BetterSqlite3Adapter(':memory:')
		store = new Store({ schema: minimalSchema, adapter, nodeId: 'test-node-abc123' })
		await store.open()
		mgr = store.getSequenceManager()
	})

	afterEach(async () => {
		await store.close()
	})

	describe('next()', () => {
		test('returns first value starting at 1 by default', async () => {
			const val = await mgr.next('order')
			expect(val).toBe('order-0001')
		})

		test('increments on each call', async () => {
			const v1 = await mgr.next('order')
			const v2 = await mgr.next('order')
			const v3 = await mgr.next('order')
			expect(v1).toBe('order-0001')
			expect(v2).toBe('order-0002')
			expect(v3).toBe('order-0003')
		})

		test('respects custom startAt', async () => {
			const val = await mgr.next('order', { startAt: 100 })
			expect(val).toBe('order-0100')
		})

		test('uses custom format template', async () => {
			const val = await mgr.next('receipt', {
				format: 'REC-{seq:6}',
			})
			expect(val).toBe('REC-000001')
		})

		test('format with {node4}', async () => {
			const val = await mgr.next('inv', {
				format: '{node4}-{seq}',
			})
			expect(val).toBe('test-0001')
		})

		test('separate sequences are independent', async () => {
			const a1 = await mgr.next('order')
			const b1 = await mgr.next('receipt')
			const a2 = await mgr.next('order')
			const b2 = await mgr.next('receipt')

			expect(a1).toBe('order-0001')
			expect(b1).toBe('receipt-0001')
			expect(a2).toBe('order-0002')
			expect(b2).toBe('receipt-0002')
		})

		test('scoped sequences are independent', async () => {
			const s1 = await mgr.next('receipt', { scope: 'store-A' })
			const s2 = await mgr.next('receipt', { scope: 'store-B' })
			const s1b = await mgr.next('receipt', { scope: 'store-A' })

			expect(s1).toBe('receipt-0001')
			expect(s2).toBe('receipt-0001')
			expect(s1b).toBe('receipt-0002')
		})

		test('persists across SequenceManager instances', async () => {
			await mgr.next('order')
			await mgr.next('order')

			// Create a new manager pointing to the same DB
			const mgr2 = new SequenceManager(adapter, 'test-node-abc123')
			const val = await mgr2.next('order')
			expect(val).toBe('order-0003')
		})

		test('different nodeIds have independent counters', async () => {
			const mgr2 = new SequenceManager(adapter, 'other-node')

			const v1 = await mgr.next('order')
			const v2 = await mgr2.next('order')

			expect(v1).toBe('order-0001')
			expect(v2).toBe('order-0001')
		})

		test('format with {date} uses current UTC date', async () => {
			const val = await mgr.next('receipt', {
				format: '{date}-{seq}',
			})
			// Should start with today's UTC date in YYYYMMDD format
			const now = new Date()
			const yyyy = String(now.getUTCFullYear())
			const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
			const dd = String(now.getUTCDate()).padStart(2, '0')
			expect(val).toBe(`${yyyy}${mm}${dd}-0001`)
		})

		test('full receipt-style format', async () => {
			const val = await mgr.next('receipt', {
				scope: 'store-1',
				format: 'S-{date}-{node4}-{seq}',
			})
			const now = new Date()
			const yyyy = String(now.getUTCFullYear())
			const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
			const dd = String(now.getUTCDate()).padStart(2, '0')
			expect(val).toBe(`S-${yyyy}${mm}${dd}-test-0001`)
		})
	})

	describe('current()', () => {
		test('returns 0 for unused sequence', async () => {
			const val = await mgr.current('unused')
			expect(val).toBe(0)
		})

		test('returns current value after next()', async () => {
			await mgr.next('order')
			await mgr.next('order')
			const val = await mgr.current('order')
			expect(val).toBe(2)
		})

		test('respects scope', async () => {
			await mgr.next('receipt', { scope: 'store-A' })
			await mgr.next('receipt', { scope: 'store-A' })
			await mgr.next('receipt', { scope: 'store-B' })

			expect(await mgr.current('receipt', { scope: 'store-A' })).toBe(2)
			expect(await mgr.current('receipt', { scope: 'store-B' })).toBe(1)
			expect(await mgr.current('receipt')).toBe(0) // no default scope
		})

		test('does not increment the counter', async () => {
			await mgr.next('order')
			await mgr.current('order')
			await mgr.current('order')
			const val = await mgr.next('order')
			expect(val).toBe('order-0002')
		})
	})

	describe('reset()', () => {
		test('resets counter to 0 by default', async () => {
			await mgr.next('order')
			await mgr.next('order')
			await mgr.reset('order')

			const val = await mgr.current('order')
			expect(val).toBe(0)
		})

		test('next() starts fresh after reset', async () => {
			await mgr.next('order')
			await mgr.next('order')
			await mgr.reset('order')

			const val = await mgr.next('order')
			expect(val).toBe('order-0001')
		})

		test('resets to specific value', async () => {
			await mgr.next('order')
			await mgr.reset('order', { to: 50 })

			const val = await mgr.current('order')
			expect(val).toBe(50)

			const next = await mgr.next('order')
			expect(next).toBe('order-0051')
		})

		test('respects scope', async () => {
			await mgr.next('receipt', { scope: 'A' })
			await mgr.next('receipt', { scope: 'A' })
			await mgr.next('receipt', { scope: 'B' })

			await mgr.reset('receipt', { scope: 'A' })

			expect(await mgr.current('receipt', { scope: 'A' })).toBe(0)
			expect(await mgr.current('receipt', { scope: 'B' })).toBe(1)
		})

		test('reset on unused sequence is a no-op', async () => {
			await mgr.reset('nonexistent')
			expect(await mgr.current('nonexistent')).toBe(0)
		})
	})

	describe('accessed via Store', () => {
		test('getSequenceManager() returns manager', () => {
			const seqMgr = store.getSequenceManager()
			expect(seqMgr).toBeInstanceOf(SequenceManager)
		})

		test('sequence works through store', async () => {
			const seqMgr = store.getSequenceManager()
			const val = await seqMgr.next('test', { format: '{seq:3}' })
			expect(val).toBe('001')
		})
	})
})

import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { Store } from '../../src/store/store'

/**
 * A clock rebase gives unsynced operations new timestamps, so new ids. The in-memory causal
 * heads (the last operation per collection, the next write's causalDeps) must follow, or the
 * next local write depends on an id that no longer exists anywhere.
 */
const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

afterEach(() => vi.restoreAllMocks())

async function opIds(adapter: BetterSqlite3Adapter): Promise<Set<string>> {
	return new Set(
		(await adapter.query<{ id: string }>('SELECT id FROM _kora_ops_todos')).map((r) => r.id),
	)
}

describe('a clock rebase keeps causal heads pointing at the log', () => {
	test('the next write after a rebase depends only on operations in the log', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		const store = new Store({ schema, adapter })
		await store.open()
		const ahead = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000)
		await store.collection('todos').insert({ title: 'written with a clock ahead' })
		ahead.mockRestore()
		const before = [...(await opIds(adapter))]
		await store.rebaseUnsyncedOperations(before, Date.now())
		const afterRebase = await opIds(adapter)
		await store.collection('todos').insert({ title: 'after the rebase' })
		const log = await opIds(adapter)
		const fresh = [...log].filter((id) => !afterRebase.has(id))
		expect(fresh).toHaveLength(1)
		const [row] = await adapter.query<{ causal_deps: string }>(
			'SELECT causal_deps FROM _kora_ops_todos WHERE id = ?',
			[fresh[0]],
		)
		const deps: string[] = JSON.parse(row?.causal_deps ?? '[]')
		// The previous write (now under its rebased id) is its causal parent.
		expect(deps.length).toBeGreaterThan(0)
		for (const dep of deps) expect(log.has(dep)).toBe(true)
		await store.close()
	})

	test('a write made while a rebase runs is neither lost nor rebased', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		const store = new Store({ schema, adapter })
		await store.open()
		const ahead = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000)
		await store.collection('todos').insert({ title: 'old' })
		ahead.mockRestore()
		const rebased = [...(await opIds(adapter))]
		const rebase = store.rebaseUnsyncedOperations(rebased, Date.now())
		const concurrent = store.collection('todos').insert({ title: 'concurrent' })
		await Promise.all([rebase, concurrent])
		const rows = await store.collection('todos').where({}).exec()
		expect(rows.map((row) => row.title).sort()).toEqual(['concurrent', 'old'])
		await store.close()
	})

	// Review of #306: the rebase's transaction ends before the store remaps its heads. A write
	// already queued behind that transaction must not build its causalDeps from the old head.
	test('a write queued behind the rebase depends only on operations in the final log', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		const store = new Store({ schema, adapter })
		await store.open()
		const ahead = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000)
		await store.collection('todos').insert({ title: 'written with a clock ahead' })
		ahead.mockRestore()
		const before = [...(await opIds(adapter))]
		// The interleaving the review describes: the rebase's transaction commits, then the next
		// queued write's transaction runs before the rebase's code after it does (a slow
		// continuation). The first transaction from here on is the rebase's; it hands back only
		// once the next one (the write's) has finished.
		const original = adapter.transaction.bind(adapter)
		let calls = 0
		let writeDone: () => void = () => {}
		const writeFinished = new Promise<void>((resolve) => {
			writeDone = resolve
		})
		let queued: Promise<unknown> | null = null
		vi.spyOn(adapter, 'transaction').mockImplementation(async (fn, options) => {
			const call = ++calls
			if (call === 1) {
				const result = await original(fn, options)
				// Committed: now the queued write runs before this resolves.
				queued = store.collection('todos').insert({ title: 'queued behind the rebase' })
				await writeFinished
				return result
			}
			const result = await original(fn, options)
			if (call === 2) writeDone()
			return result
		})
		await store.rebaseUnsyncedOperations(before, Date.now())
		await queued
		const log = await opIds(adapter)
		const rows = await adapter.query<{ id: string; causal_deps: string }>(
			'SELECT id, causal_deps FROM _kora_ops_todos',
		)
		for (const row of rows) {
			for (const dep of JSON.parse(row.causal_deps) as string[]) expect(log.has(dep)).toBe(true)
		}
		await store.close()
	})

	// Review round 2 of #306: when the rewrite fails at commit, the heads it remapped must not be
	// seen by a write the database lock wakes before the store has undone the remap.
	test('a rewrite that fails at commit leaves no queued write depending on its ids', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		const store = new Store({ schema, adapter })
		await store.open()
		const ahead = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000)
		await store.collection('todos').insert({ title: 'written with a clock ahead' })
		ahead.mockRestore()
		const before = [...(await opIds(adapter))]
		const original = adapter.transaction.bind(adapter)
		let calls = 0
		let queued: Promise<unknown> | null = null
		vi.spyOn(adapter, 'transaction').mockImplementation(async (fn, options) => {
			const call = ++calls
			if (call !== 1) return original(fn, options)
			// The rewrite's body runs (the remap included), then its commit fails: rolled back.
			const failure = new Error('commit failed')
			await original(async (tx) => {
				await fn(tx)
				throw failure
			}, options).catch(() => {})
			// The lock is free again; a write starts before the store sees the failure. It is given
			// a moment to run; held back by the store, it runs after the undo instead.
			queued = store.collection('todos').insert({ title: 'queued behind the failed rewrite' })
			await Promise.race([queued, new Promise((resolve) => setTimeout(resolve, 100))])
			throw failure
		})
		await expect(store.rebaseUnsyncedOperations(before, Date.now())).rejects.toThrow(
			'commit failed',
		)
		await queued
		const log = await opIds(adapter)
		// Rolled back: the original operation is still there under its old id.
		for (const id of before) expect(log.has(id)).toBe(true)
		const rows = await adapter.query<{ id: string; causal_deps: string }>(
			'SELECT id, causal_deps FROM _kora_ops_todos',
		)
		for (const row of rows) {
			for (const dep of JSON.parse(row.causal_deps) as string[]) expect(log.has(dep)).toBe(true)
		}
		await store.close()
	})
})

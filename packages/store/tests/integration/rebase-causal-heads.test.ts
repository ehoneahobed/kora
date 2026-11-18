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
})

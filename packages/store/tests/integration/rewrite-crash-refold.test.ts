import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { Store } from '../../src/store/store'
import { listLocalNodes, setLocalNodePrincipal } from '../../src/sync/local-sync-records'
import type { Transaction } from '../../src/types'

/**
 * A clock rebase and a node rotation rewrite unsynced operations (new timestamps or a new node,
 * so new ids) and their records must be re-folded: a fold state still holding the old stamps
 * orders remote writes differently from every other replica, for good. A crash right after the
 * rewrite commits must not leave that state behind, nor lose the fresh node's user binding.
 */
const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string(), count: t.number().default(0) } } },
})

/** better-sqlite3 that "crashes" (every call throws) once `crashAfter` transactions committed. */
class CrashingAdapter extends BetterSqlite3Adapter {
	crashAfter: number | null = null
	private committed = 0
	private crashed = false
	override async transaction(fn: (tx: Transaction) => Promise<void>): Promise<void> {
		if (this.crashed) throw new Error('crashed')
		await super.transaction(fn)
		if (this.crashAfter !== null && ++this.committed >= this.crashAfter) this.crashed = true
	}
	override async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
		if (this.crashed) throw new Error('crashed')
		return super.query<T>(sql, params)
	}
	override async execute(sql: string, params?: unknown[]): Promise<void> {
		if (this.crashed) throw new Error('crashed')
		return super.execute(sql, params)
	}
	/** Arm the crash after the next `n` committed transactions. */
	armAfter(n: number): void {
		this.committed = 0
		this.crashAfter = n
	}
	/** The process died: the file is released without the store closing anything. */
	async die(): Promise<void> {
		this.crashed = false
		this.crashAfter = null
		await super.close()
	}
}

const dirs: string[] = []
afterEach(() => {
	vi.restoreAllMocks()
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function seeded() {
	const dir = mkdtempSync(join(tmpdir(), 'kora-rewrite-crash-'))
	dirs.push(dir)
	const path = join(dir, 'app.db')
	const adapter = new CrashingAdapter(path)
	const store = new Store({ schema, adapter })
	await store.open()
	// Writes made with a clock ten minutes ahead: far-future stamps a rebase corrects.
	const ahead = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000)
	const todos = store.collection('todos')
	const a = await todos.insert({ title: 'a' })
	await todos.insert({ title: 'b' })
	await todos.update(a.id, { title: 'a2', count: 1 })
	ahead.mockRestore()
	const ids = (await adapter.query<{ id: string }>('SELECT id FROM _kora_ops_todos')).map(
		(r) => r.id,
	)
	return { path, adapter, store, ids }
}

async function reopen(path: string): Promise<{ store: Store; adapter: BetterSqlite3Adapter }> {
	const adapter = new BetterSqlite3Adapter(path)
	const store = new Store({ schema, adapter })
	await store.open()
	return { store, adapter }
}

/** Every record's fold state equals a fresh fold of its log. */
async function expectFoldStatesFresh(store: Store, adapter: BetterSqlite3Adapter): Promise<void> {
	const read = () =>
		adapter.query<{ record_id: string; state: string }>(
			'SELECT record_id, state FROM _kora_fold_state ORDER BY record_id',
		)
	const before = await read()
	const ids = (await adapter.query<{ id: string }>('SELECT id FROM _kora_ops_todos')).map(
		(r) => r.id,
	)
	await (store as unknown as { refoldRecordsOf(ids: string[]): Promise<void> }).refoldRecordsOf(ids)
	expect(before.length).toBeGreaterThan(0)
	expect(before).toEqual(await read())
}

describe('a crash right after a log rewrite commits leaves no stale fold state', () => {
	test('clock rebase', async () => {
		const { path, adapter, store, ids } = await seeded()
		adapter.armAfter(1)
		await store.rebaseUnsyncedOperations(ids, Date.now()).catch(() => undefined)
		await adapter.die()
		const reopened = await reopen(path)
		try {
			await expectFoldStatesFresh(reopened.store, reopened.adapter)
		} finally {
			await reopened.store.close()
		}
	})

	test('node rotation: fold states are fresh and the fresh node keeps its user', async () => {
		const { path, adapter, store, ids } = await seeded()
		const oldNodeId = store.getNodeId()
		await setLocalNodePrincipal(adapter, oldNodeId, 'user-1', 'app')
		adapter.armAfter(1)
		await store.rotateNodeId(ids).catch(() => undefined)
		await adapter.die()
		const reopened = await reopen(path)
		try {
			await expectFoldStatesFresh(reopened.store, reopened.adapter)
			const fresh = (await listLocalNodes(reopened.adapter)).filter((n) => n.nodeId !== oldNodeId)
			expect(fresh.map((n) => n.principal)).toContain('user-1')
		} finally {
			await reopened.store.close()
		}
	})
})

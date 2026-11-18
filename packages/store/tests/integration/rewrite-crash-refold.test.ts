import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HybridLogicalClock, defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
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

/** A database written under `writerNode`, reopened (crash-armable) under `ownNode`. */
async function writtenByAnotherNode(
	writerNode: string,
	ownNode: string,
	owner?: string,
): Promise<{ path: string; adapter: CrashingAdapter; store: Store; ids: string[] }> {
	const dir = mkdtempSync(join(tmpdir(), 'kora-rewrite-crash-'))
	dirs.push(dir)
	const path = join(dir, owner ? `kora-db__user_${owner}.db` : 'app.db')
	const ownerConfig = owner ? { databaseOwner: owner } : {}
	const first = new BetterSqlite3Adapter(path)
	const writer = new Store({ schema, adapter: first, nodeId: writerNode, ...ownerConfig })
	await writer.open()
	if (owner) await writer.bindPrincipal(owner)
	const todos = writer.collection('todos')
	const a = await todos.insert({ title: 'a' })
	await todos.insert({ title: 'b' })
	await todos.update(String(a.id), { title: 'a2', count: 1 })
	const ids = (await writer.getOperationRange(writerNode, 1, 10)).map((op) => op.id)
	await writer.close()
	const adapter = new CrashingAdapter(path)
	const store = new Store({ schema, adapter, nodeId: ownNode, ...ownerConfig })
	await store.open()
	if (owner) await store.bindPrincipal(owner)
	return { path, adapter, store, ids }
}

describe('a crash right after a re-author commits leaves no stale fold state', () => {
	test('reauthorLocalNode: fold states are fresh and the fresh node keeps its user', async () => {
		const { path, adapter, store, ids } = await writtenByAnotherNode('legacy-node', 'device-d')
		adapter.armAfter(1)
		await store.reauthorLocalNode('legacy-node', ids, 'alice').catch(() => undefined)
		await adapter.die()
		const reopened = await reopen(path)
		try {
			await expectFoldStatesFresh(reopened.store, reopened.adapter)
			const fresh = (await listLocalNodes(reopened.adapter)).filter(
				(n) => n.nodeId !== 'legacy-node' && n.nodeId !== 'device-d',
			)
			expect(fresh).toHaveLength(1)
			expect(fresh[0]).toMatchObject({ principal: 'alice', binding: 'fresh' })
			const moved = await reopened.store.getOperationRange(String(fresh[0]?.nodeId), 1, 10)
			expect(moved).toHaveLength(ids.length)
		} finally {
			await reopened.store.close()
		}
	})

	test('reauthorIntoOwnNode, appended to the own node: fold states are fresh', async () => {
		const { path, adapter, store, ids } = await writtenByAnotherNode(
			'browser-device',
			'kofi-own-device',
			'kofi',
		)
		adapter.armAfter(1)
		await store.reauthorIntoOwnNode('browser-device', ids).catch(() => undefined)
		await adapter.die()
		const reopened = await reopen(path)
		try {
			await expectFoldStatesFresh(reopened.store, reopened.adapter)
			const own = await reopened.store.getOperationRange('kofi-own-device', 1, 10)
			expect(own).toHaveLength(ids.length)
		} finally {
			await reopened.store.close()
		}
	})

	test('reauthorIntoOwnNode, falling back to a fresh node: fold states are fresh and it keeps its user', async () => {
		const { path, adapter, store, ids } = await writtenByAnotherNode(
			'browser-device',
			'kofi-own-device',
			'kofi',
		)
		await store.collection('todos').insert({ title: 'own write' })
		const [own] = await store.getOperationRange('kofi-own-device', 1, 1)
		if (!own) throw new Error('no own operation')
		// The clock went back: a previous-node operation carries the own write's wall/logical.
		await adapter.execute('UPDATE _kora_ops_todos SET timestamp = ? WHERE id = ?', [
			HybridLogicalClock.serialize({ ...own.timestamp, nodeId: 'browser-device' }),
			ids.at(-1),
		])
		adapter.armAfter(1)
		await store.reauthorIntoOwnNode('browser-device', ids).catch(() => undefined)
		await adapter.die()
		const reopened = await reopen(path)
		try {
			await expectFoldStatesFresh(reopened.store, reopened.adapter)
			const fresh = (await listLocalNodes(reopened.adapter)).filter(
				(n) => n.nodeId !== 'browser-device' && n.nodeId !== 'kofi-own-device',
			)
			expect(fresh).toHaveLength(1)
			expect(fresh[0]).toMatchObject({ principal: 'kofi', binding: 'fresh' })
			expect(await reopened.store.getOperationRange(String(fresh[0]?.nodeId), 1, 10)).toHaveLength(
				ids.length,
			)
		} finally {
			await reopened.store.close()
		}
	})
})

/** Every operation in a store's log, oldest first by sequence. */
async function allOperations(store: Store, adapter: BetterSqlite3Adapter): Promise<Operation[]> {
	const nodes = (await listLocalNodes(adapter)).map((n) => n.nodeId)
	const all: Operation[] = []
	for (const nodeId of new Set([...nodes, store.getNodeId()])) {
		all.push(...(await store.getOperationRange(nodeId, 1, 1000)))
	}
	return all
}

describe('a replica that crashed after a clock rebase converges with one that did not', () => {
	test('a remote write stamped between the old and the corrected time wins on both', async () => {
		const { path, adapter, store, ids } = await seeded()
		adapter.armAfter(1)
		await store.rebaseUnsyncedOperations(ids, Date.now()).catch(() => undefined)
		await adapter.die()
		const a = await reopen(path)
		const dir = mkdtempSync(join(tmpdir(), 'kora-rewrite-crash-b-'))
		dirs.push(dir)
		const bAdapter = new BetterSqlite3Adapter(join(dir, 'b.db'))
		const b = new Store({ schema, adapter: bAdapter, nodeId: 'replica-b' })
		await b.open()
		const cAdapter = new BetterSqlite3Adapter(join(dir, 'c.db'))
		const c = new Store({ schema, adapter: cAdapter, nodeId: 'replica-c' })
		await c.open()
		try {
			// B and C receive A's (rebased) log, as the server would deliver it.
			const fromA = await allOperations(a.store, a.adapter)
			expect(fromA.length).toBeGreaterThan(0)
			for (const op of fromA) {
				await b.applyRemoteOperation(op)
				await c.applyRemoteOperation(op)
			}
			// C edits a record one minute ahead: after the corrected stamps, before the old ones.
			const [record] = await c.collection('todos').where({ title: 'a2' }).exec()
			if (!record) throw new Error('record a2 missing on C')
			const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
			await c.collection('todos').update(String(record.id), { title: 'from C' })
			later.mockRestore()
			for (const op of await c.getOperationRange('replica-c', 1, 10)) {
				await a.store.applyRemoteOperation(op)
				await b.applyRemoteOperation(op)
			}
			const titles = async (s: Store) =>
				(await s.collection('todos').where({}).exec()).map((row) => row.title).sort()
			expect(await titles(a.store)).toEqual(await titles(b))
			expect(await titles(a.store)).toContain('from C')
		} finally {
			await a.store.close()
			await b.close()
			await c.close()
		}
	})
})

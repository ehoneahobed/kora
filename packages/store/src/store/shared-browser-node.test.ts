/**
 * A database namespaced by user whose pinned node moved: on a browser shared between
 * accounts, beta.12 gave every account the browser's one device id, so two users'
 * databases authored under one node. Each account now gets a device id (and node) of its
 * own; the database retires the node it moved off and later re-authors the writes the
 * server does not hold under its own node.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HybridLogicalClock, defineSchema, t } from '@korajs/core'
import type { KoraError } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { listLocalNodes } from '../sync/local-sync-records'
import { SEQ_CONFLICTS_TABLE, uniqueSequenceIndexName } from './sequence-repair'
import { Store } from './store'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string(), done: t.boolean().default(false) } } },
})

const stores: Store[] = []
const dirs: string[] = []
afterEach(async () => {
	for (const s of stores.splice(0)) await s.close().catch(() => undefined)
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function databaseFile(): string {
	const dir = mkdtempSync(join(tmpdir(), 'shared-browser-node-'))
	dirs.push(dir)
	return join(dir, 'kora-db__user_kofi.db')
}

async function open(
	file: string,
	nodeId: string,
	databaseOwner?: string,
): Promise<{ store: Store; adapter: BetterSqlite3Adapter }> {
	const adapter = new BetterSqlite3Adapter(file)
	const store = new Store({ schema, adapter, nodeId, ...(databaseOwner ? { databaseOwner } : {}) })
	await store.open()
	if (databaseOwner) await store.bindPrincipal(databaseOwner)
	stores.push(store)
	return { store, adapter }
}

async function close(store: Store): Promise<void> {
	stores.splice(stores.indexOf(store), 1)
	await store.close()
}

/** Put operations in the outbound queue, as an unsent write sits there. */
async function queue(adapter: BetterSqlite3Adapter, ops: Array<{ id: string }>): Promise<void> {
	for (const op of ops) {
		await adapter.execute('INSERT OR IGNORE INTO _kora_sync_queue (id, payload) VALUES (?, ?)', [
			op.id,
			JSON.stringify({ id: op.id }),
		])
	}
}

async function queuedIds(adapter: BetterSqlite3Adapter): Promise<string[]> {
	return (await adapter.query<{ id: string }>('SELECT id FROM _kora_sync_queue ORDER BY id')).map(
		(row) => row.id,
	)
}

/** Kofi's database on a beta.12 shared browser: written under the browser's one device id. */
async function sharedNodeDatabase(file: string): Promise<string[]> {
	const { store } = await open(file, 'browser-device', 'kofi')
	const todos = store.collection('todos')
	const a = await todos.insert({ title: 'lesson 1' })
	await todos.update(String(a.id), { done: true })
	await todos.insert({ title: 'submission' })
	const ids = (await store.getOperationRange('browser-device', 1, 10)).map((op) => op.id)
	await close(store)
	return ids
}

describe('a namespaced database whose pinned node moved', () => {
	test('retires the previous node for the database owner, and writes go to the new one', async () => {
		const file = databaseFile()
		await sharedNodeDatabase(file)
		const { store, adapter } = await open(file, 'kofi-own-device', 'kofi')
		const nodes = await listLocalNodes(adapter)
		expect(nodes.find((n) => n.nodeId === 'browser-device')).toMatchObject({
			retired: true,
			principal: 'kofi',
			binding: 'database',
		})
		expect(nodes.find((n) => n.nodeId === 'kofi-own-device')).toMatchObject({
			retired: false,
			principal: 'kofi',
		})
		const written = await store.collection('todos').insert({ title: 'after the move' })
		const [op] = await store.getOperationRange('kofi-own-device', 1, 1)
		expect(op?.recordId).toBe(written.id)
		// Nothing of the previous node was touched.
		expect(await store.getOperationRange('browser-device', 1, 10)).toHaveLength(3)
	})

	test('a database not namespaced by user does not retire the node (it may be several users’)', async () => {
		const file = databaseFile()
		await sharedNodeDatabase(file)
		const { adapter } = await open(file, 'another-device')
		expect(
			(await listLocalNodes(adapter)).find((n) => n.nodeId === 'browser-device')?.retired,
		).toBe(false)
	})

	test('a retired node pinned again is revived', async () => {
		const file = databaseFile()
		await sharedNodeDatabase(file)
		const moved = await open(file, 'kofi-own-device', 'kofi')
		await close(moved.store)
		const back = await open(file, 'browser-device', 'kofi')
		const nodes = await listLocalNodes(back.adapter)
		expect(nodes.find((n) => n.nodeId === 'browser-device')?.retired).toBe(false)
		expect(nodes.find((n) => n.nodeId === 'kofi-own-device')).toMatchObject({ retired: true })
	})

	test('re-authors the given operations under its own node, after its own writes', async () => {
		const file = databaseFile()
		const [insertId, updateId, secondId] = await sharedNodeDatabase(file)
		const { store } = await open(file, 'kofi-own-device', 'kofi')
		await store.collection('todos').insert({ title: 'made after the move' })
		const original = await store.getOperationRange('browser-device', 1, 10)

		// The server holds the first insert; the update and the second insert never reached it.
		const result = await store.reauthorIntoOwnNode('browser-device', [
			String(updateId),
			String(secondId),
		])
		expect(result.nodeId).toBe('kofi-own-device')
		expect(result.operations.map((op) => op.sequenceNumber)).toEqual([2, 3])
		for (const op of result.operations) {
			expect(op.nodeId).toBe('kofi-own-device')
			expect(op.timestamp.nodeId).toBe('kofi-own-device')
		}
		const before = new Map(original.map((op) => [op.id, op]))
		for (const [oldId, newId] of Object.entries(result.idMapping)) {
			expect(newId).not.toBe(oldId)
			const old = before.get(oldId)
			const rewritten = result.operations.find((op) => op.id === newId)
			expect(rewritten).toMatchObject({
				type: old?.type,
				recordId: old?.recordId,
				data: old?.data,
				timestamp: { wallTime: old?.timestamp.wallTime, logical: old?.timestamp.logical },
			})
		}
		// The previous node keeps only what the server holds; the own node continues after.
		expect((await store.getOperationRange('browser-device', 1, 10)).map((op) => op.id)).toEqual([
			insertId,
		])
		expect(store.getVersionVector().get('kofi-own-device')).toBe(3)
		await store.collection('todos').insert({ title: 'next write' })
		expect(store.getVersionVector().get('kofi-own-device')).toBe(4)
		// Records read exactly as before.
		const rows = await store.collection('todos').where({}).exec()
		expect(rows.map((row) => [row.title, row.done]).sort()).toEqual([
			['lesson 1', true],
			['made after the move', false],
			['next write', false],
			['submission', false],
		])
	})

	test('rewrites causal deps among the re-authored operations', async () => {
		const file = databaseFile()
		const [insertId, updateId] = await sharedNodeDatabase(file)
		const { store } = await open(file, 'kofi-own-device', 'kofi')
		const original = await store.getOperationRange('browser-device', 1, 10)
		const update = original.find((op) => op.id === updateId)
		expect(update?.causalDeps).toContain(insertId)
		const result = await store.reauthorIntoOwnNode('browser-device', [
			String(insertId),
			String(updateId),
		])
		const newInsert = result.idMapping[String(insertId)]
		const newUpdate = result.operations.find((op) => op.id === result.idMapping[String(updateId)])
		expect(newUpdate?.causalDeps).toContain(newInsert)
		expect(newUpdate?.causalDeps).not.toContain(insertId)
	})

	test('falls back to a fresh node of the same user when a timestamp is taken', async () => {
		const file = databaseFile()
		const [, , secondId] = await sharedNodeDatabase(file)
		const { store, adapter } = await open(file, 'kofi-own-device', 'kofi')
		await store.collection('todos').insert({ title: 'own write' })
		const [own] = await store.getOperationRange('kofi-own-device', 1, 1)
		if (!own) throw new Error('no own operation')
		// The clock went back: a previous-node operation carries the own write's wall/logical.
		await adapter.execute('UPDATE _kora_ops_todos SET timestamp = ? WHERE id = ?', [
			HybridLogicalClock.serialize({ ...own.timestamp, nodeId: 'browser-device' }),
			secondId,
		])
		const result = await store.reauthorIntoOwnNode('browser-device', [String(secondId)])
		expect(result.nodeId).not.toBe('kofi-own-device')
		expect((await listLocalNodes(adapter)).find((n) => n.nodeId === result.nodeId)).toMatchObject({
			principal: 'kofi',
			binding: 'fresh',
		})
		// Nothing was written for the refused append.
		expect(store.getVersionVector().get('kofi-own-device')).toBe(1)
	})

	test('refuses a node that is not retired', async () => {
		const file = databaseFile()
		await sharedNodeDatabase(file)
		const { store } = await open(file, 'kofi-own-device', 'kofi')
		await expect(store.reauthorIntoOwnNode('kofi-own-device', [])).rejects.toMatchObject({
			code: 'NODE_ID_UNKNOWN',
		} satisfies Partial<KoraError>)
		await expect(store.reauthorIntoOwnNode('unknown-node', [])).rejects.toMatchObject({
			code: 'NODE_ID_UNKNOWN',
		})
	})

	test('the sequence repair renumbers a duplicate under the retired node instead of moving it out', async () => {
		const file = databaseFile()
		const [, updateId] = await sharedNodeDatabase(file)
		// beta.12 left two of the node's operations under one sequence number.
		const raw = new BetterSqlite3Adapter(file)
		await raw.open(schema)
		await raw.execute(`DROP INDEX IF EXISTS "${uniqueSequenceIndexName('todos')}"`)
		await raw.execute("DELETE FROM _kora_meta WHERE key = 'seq_unique_repair_v1'")
		await raw.execute('UPDATE _kora_ops_todos SET sequence_number = 1 WHERE id = ?', [updateId])
		// Unsent when the browser was upgraded: this database's own writes.
		await queue(raw, await raw.query<{ id: string }>('SELECT id FROM _kora_ops_todos'))
		await raw.close()

		const { store, adapter } = await open(file, 'kofi-own-device', 'kofi')
		const conflicts = await adapter.query<{ id: string; reemitted_as: string | null }>(
			`SELECT id, reemitted_as FROM ${SEQ_CONFLICTS_TABLE}`,
		)
		expect(conflicts).toHaveLength(1)
		expect(conflicts[0]?.reemitted_as).not.toBeNull()
		// Both operations are still in the previous node's log, under distinct numbers.
		const ops = await store.getOperationRange('browser-device', 1, 10)
		expect(ops).toHaveLength(3)
		expect(new Set(ops.map((op) => op.sequenceNumber)).size).toBe(3)
	})
	test('a duplicate it received under the retired node is kept aside, never renumbered as its own', async () => {
		const file = databaseFile()
		const [, updateId] = await sharedNodeDatabase(file)
		const raw = new BetterSqlite3Adapter(file)
		await raw.open(schema)
		await raw.execute(`DROP INDEX IF EXISTS "${uniqueSequenceIndexName('todos')}"`)
		await raw.execute("DELETE FROM _kora_meta WHERE key = 'seq_unique_repair_v1'")
		await raw.execute('UPDATE _kora_ops_todos SET sequence_number = 1 WHERE id = ?', [updateId])
		// This database recorded the second one as received (another account's write under
		// the shared node).
		await raw.execute(
			'CREATE TABLE IF NOT EXISTS _kora_received_local_ops (id TEXT PRIMARY KEY NOT NULL)',
		)
		await raw.execute('INSERT INTO _kora_received_local_ops (id) VALUES (?)', [updateId])
		await raw.close()

		const { store, adapter } = await open(file, 'kofi-own-device', 'kofi')
		const conflicts = await adapter.query<{ id: string; reemitted_as: string | null }>(
			`SELECT id, reemitted_as FROM ${SEQ_CONFLICTS_TABLE}`,
		)
		expect(conflicts).toHaveLength(1)
		expect(conflicts[0]?.reemitted_as).toBeNull()
		expect(await store.getOperationRange('browser-device', 1, 10)).toHaveLength(2)
	})

	test('rewrites the outbound queue in the same transaction as the operations', async () => {
		const file = databaseFile()
		const ids = await sharedNodeDatabase(file)
		const raw = new BetterSqlite3Adapter(file)
		await raw.open(schema)
		await queue(
			raw,
			ids.map((id) => ({ id })),
		)
		await raw.close()
		const { store } = await open(file, 'kofi-own-device', 'kofi')
		const result = await store.reauthorIntoOwnNode('browser-device', ids.slice(1))
		// The process ends here (before the sync engine updates its queue): the queue already
		// holds the re-authored operations, never the ids that left the log.
		await close(store)
		const queued = await (async () => {
			const again = new BetterSqlite3Adapter(file)
			await again.open(schema)
			const found = await queuedIds(again)
			await again.close()
			return found
		})()
		expect(queued).toEqual([ids[0], ...Object.values(result.idMapping)].sort())
	})

	test('drops queue entries of operations an earlier run re-authored', async () => {
		const file = databaseFile()
		const ids = await sharedNodeDatabase(file)
		const { store, adapter } = await open(file, 'kofi-own-device', 'kofi')
		await store.reauthorIntoOwnNode('browser-device', ids.slice(1))
		// An entry of a re-authored operation came back (written by a release that updated
		// the queue after the operations, and stopped in between).
		await queue(adapter, [{ id: String(ids[1]) }])
		await close(store)
		const reopened = await open(file, 'kofi-own-device', 'kofi')
		expect(await queuedIds(reopened.adapter)).not.toContain(ids[1])
	})

	test('rewrites causal deps on an operation re-authored in an earlier batch', async () => {
		const file = databaseFile()
		const [insertId, updateId] = await sharedNodeDatabase(file)
		const { store } = await open(file, 'kofi-own-device', 'kofi')
		// More than one handshake's worth: the insert is re-authored first, its update later.
		const first = await store.reauthorIntoOwnNode('browser-device', [String(insertId)])
		const second = await store.reauthorIntoOwnNode('browser-device', [String(updateId)])
		const newInsert = first.idMapping[String(insertId)]
		const newUpdate = second.operations[0]
		expect(newUpdate?.causalDeps).toContain(newInsert)
		expect(newUpdate?.causalDeps).not.toContain(insertId)
	})

	test('counts every write under a node as its own except the ones it recorded as received', async () => {
		const file = databaseFile()
		const ids = await sharedNodeDatabase(file)
		// As beta.12 left it: no node registry, nothing recorded as received, and nothing in
		// the outbound queue (beta.12 dropped the entries of writes it wrongly counted as synced).
		const legacy = new BetterSqlite3Adapter(file)
		await legacy.open(schema)
		await legacy.execute('DELETE FROM _kora_local_nodes')
		await legacy.execute('DELETE FROM _kora_sync_queue')
		await legacy.close()
		// Another database's write under the same node, delivered to this one now.
		const other = databaseFile().replace('kofi', 'ama')
		const ama = await open(other, 'browser-device', 'ama')
		for (let i = 0; i < 4; i++) await ama.store.collection('todos').insert({ title: `ama ${i}` })
		const [received] = await ama.store.getOperationRange('browser-device', 4, 4)
		if (!received) throw new Error('no operation')
		await close(ama.store)

		const { store } = await open(file, 'kofi-own-device', 'kofi')
		await store.applyRemoteOperation(received)
		const ops = await store.getOperationRange('browser-device', 1, 10)
		expect(ops.map((op) => op.id)).toContain(received.id)
		const authored = await store.findAuthoredHere('browser-device', ops)
		// Its own writes, queued or not; never the one it received.
		expect([...authored].sort()).toEqual([...ids].sort())
	})

	test('a write made under a node counts as its own without the queue', async () => {
		const file = databaseFile()
		const { store } = await open(file, 'fresh-node', 'kofi')
		await store.collection('todos').insert({ title: 'mine' })
		const ops = await store.getOperationRange('fresh-node', 1, 1)
		expect([...(await store.findAuthoredHere('fresh-node', ops))]).toEqual(ops.map((op) => op.id))
	})
})

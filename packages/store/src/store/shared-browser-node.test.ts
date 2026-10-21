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
})

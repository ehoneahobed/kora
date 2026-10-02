import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import {
	LOCAL_NODES_TABLE,
	ensureLocalSyncRecordTables,
	listLocalNodes,
	loadAdoptionSchedule,
	saveAdoptionSchedule,
} from '../sync/local-sync-records'
import { NODE_TOKEN_META_KEY, loadNodeToken, nodeTokenKey } from '../sync/sync-state'
import { Store } from './store'

/** RT-42: local writes belong to the signed-in user, not to whichever node is in use. */
const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

const stores: Store[] = []
afterEach(async () => {
	for (const s of stores.splice(0)) await s.close()
})

async function open(
	options: { adapter?: BetterSqlite3Adapter; nodeId?: string; isolation?: 'per-tab' } = {},
): Promise<{ store: Store; adapter: BetterSqlite3Adapter }> {
	const adapter = options.adapter ?? new BetterSqlite3Adapter(':memory:')
	const store = new Store({
		schema,
		adapter,
		...(options.nodeId ? { nodeId: options.nodeId } : {}),
		...(options.isolation ? { isolation: options.isolation } : {}),
	})
	await store.open()
	stores.push(store)
	return { store, adapter }
}

async function nodeRecord(adapter: BetterSqlite3Adapter, nodeId: string) {
	return (await listLocalNodes(adapter)).find((n) => n.nodeId === nodeId)
}

async function principalOf(adapter: BetterSqlite3Adapter, nodeId: string): Promise<string | null> {
	return (await listLocalNodes(adapter)).find((n) => n.nodeId === nodeId)?.principal ?? null
}

describe('Store.bindPrincipal (RT-42)', () => {
	test('an unbound node with no history is bound to the first signed-in user, without moving', async () => {
		const { store, adapter } = await open()
		const node = store.getNodeId()
		const binding = await store.bindPrincipal('alice')
		expect(binding).toEqual({
			nodeId: node,
			previousNodeId: node,
			switched: false,
			conflict: false,
		})
		expect(await principalOf(adapter, node)).toBe('alice')
		expect((await nodeRecord(adapter, node))?.binding).toBe('fresh')
		// Idempotent for the same user.
		expect((await store.bindPrincipal('alice')).switched).toBe(false)
	})

	test('RT-50: an unbound node with writes is never given to the first signed-in user', async () => {
		const { store, adapter } = await open()
		const node = store.getNodeId()
		await store.collection('todos').insert({ title: 'before anyone was known' })
		const binding = await store.bindPrincipal('alice')
		expect(binding.switched).toBe(true)
		expect(binding.previousNodeId).toBe(node)
		// The old node keeps no owner: the server (or the app) says whose it is.
		expect(await principalOf(adapter, node)).toBeNull()
		expect(await principalOf(adapter, store.getNodeId())).toBe('alice')
		const write = await store.collection('todos').insert({ title: 'alice' })
		const ops = await store.getOperationRange(store.getNodeId(), 1, 1)
		expect(ops.map((op) => op.recordId)).toEqual([write.id])
	})

	test('RT-50: an unbound node that synced before is not guessed either', async () => {
		const { store, adapter } = await open()
		const node = store.getNodeId()
		await store.markLocalNodeAccepted(node)
		expect((await store.bindPrincipal('alice')).switched).toBe(true)
		expect(await principalOf(adapter, node)).toBeNull()
	})

	test('RT-50: a pinned unbound node with history stays unbound and in use (the server decides)', async () => {
		const { store, adapter } = await open({ nodeId: 'device-1' })
		await store.collection('todos').insert({ title: 'before' })
		expect(await store.bindPrincipal('alice')).toMatchObject({ switched: false, conflict: false })
		expect(await principalOf(adapter, 'device-1')).toBeNull()
		await store.confirmNodePrincipal('device-1', 'alice')
		expect(await nodeRecord(adapter, 'device-1')).toMatchObject({
			principal: 'alice',
			binding: 'server',
		})
	})

	test('RT-50: server answers bind, rule out and correct guesses; the app assigns and drops', async () => {
		const { store, adapter } = await open()
		const own = store.getNodeId()
		await store.collection('todos').insert({ title: 'unattributed' })
		await store.bindPrincipal('alice')

		// Refused for alice: remembered, still unbound.
		await store.recordNodeRefusedFor(own, 'alice')
		expect(await nodeRecord(adapter, own)).toMatchObject({
			principal: null,
			refusedPrincipals: ['alice'],
		})
		// The app cannot assign it to a user the server refused it for.
		expect(await store.assignNodePrincipal(own, 'alice')).toBe(false)
		expect(await store.assignNodePrincipal(own, 'bob')).toBe(true)
		expect(await nodeRecord(adapter, own)).toMatchObject({
			principal: 'bob',
			binding: 'app',
			held: false,
		})
		// A guess the server overrules is cleared.
		await store.recordNodeRefusedFor(own, 'bob')
		expect(await nodeRecord(adapter, own)).toMatchObject({
			principal: null,
			refusedPrincipals: ['alice', 'bob'],
		})
		// An accepted handshake binds it.
		await store.confirmNodePrincipal(own, 'carol')
		expect(await nodeRecord(adapter, own)).toMatchObject({ principal: 'carol', binding: 'server' })
		// Evidence-based bindings are never overwritten by another user's answer.
		await store.confirmNodePrincipal(own, 'dave')
		await store.recordNodeRefusedFor(own, 'carol')
		expect(await nodeRecord(adapter, own)).toMatchObject({ principal: 'carol', binding: 'server' })
		expect(await store.assignNodePrincipal(own, 'dave')).toBe(false)
		// The store's own node can be neither assigned nor dropped.
		expect(await store.assignNodePrincipal(store.getNodeId(), 'zed')).toBe(false)
		await store.dropLocalNode(store.getNodeId())
		expect(await nodeRecord(adapter, store.getNodeId())).toBeDefined()
		await store.dropLocalNode(own)
		expect(await nodeRecord(adapter, own)).toBeUndefined()
	})

	test('RT-50: re-authored writes keep their author after a rotation', async () => {
		const { store, adapter } = await open()
		await store.bindPrincipal('alice')
		const write = await store.collection('todos').insert({ title: 'alice' })
		const ops = await store.getOperationRange(store.getNodeId(), 1, 1)
		const rotated = await store.rotateNodeId(ops.map((op) => op.id))
		expect(rotated.operations.map((op) => op.recordId)).toEqual([write.id])
		expect(await nodeRecord(adapter, rotated.nodeId)).toMatchObject({
			principal: 'alice',
			binding: 'fresh',
		})
		expect((await store.bindPrincipal('alice')).switched).toBe(false)
	})

	test('another user moves to a fresh node; writes from then on are theirs', async () => {
		const { store, adapter } = await open()
		await store.bindPrincipal('alice')
		const aliceNode = store.getNodeId()
		await store.collection('todos').insert({ title: 'alice' })

		const binding = await store.bindPrincipal('bob')
		expect(binding.switched).toBe(true)
		expect(binding.previousNodeId).toBe(aliceNode)
		const bobNode = store.getNodeId()
		expect(bobNode).not.toBe(aliceNode)
		const bobWrite = await store.collection('todos').insert({ title: 'bob' })
		const ops = await store.getOperationRange(bobNode, 1, 1)
		expect(ops.map((op) => op.recordId)).toEqual([bobWrite.id])
		expect(await principalOf(adapter, aliceNode)).toBe('alice')
		expect(await principalOf(adapter, bobNode)).toBe('bob')
		// Alice's write stays under her node, untouched.
		expect(store.getVersionVector().get(aliceNode)).toBe(1)
	})

	test('a returning user moves back to their own node', async () => {
		const { store } = await open()
		await store.bindPrincipal('alice')
		const aliceNode = store.getNodeId()
		await store.bindPrincipal('bob')
		const bobNode = store.getNodeId()
		await store.bindPrincipal('alice')
		expect(store.getNodeId()).toBe(aliceNode)
		await store.collection('todos').insert({ title: 'alice again' })
		expect(store.getVersionVector().get(aliceNode)).toBe(1)
		await store.bindPrincipal('bob')
		expect(store.getNodeId()).toBe(bobNode)
	})

	test('the binding survives a reopen (the database node id moved)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'kora-principal-'))
		const file = join(dir, 'db.sqlite')
		const store = new Store({ schema, adapter: new BetterSqlite3Adapter(file) })
		await store.open()
		await store.bindPrincipal('alice')
		await store.bindPrincipal('bob')
		const bobNode = store.getNodeId()
		await store.close()
		const reopened = new Store({ schema, adapter: new BetterSqlite3Adapter(file) })
		await reopened.open()
		stores.push(reopened)
		expect(reopened.getNodeId()).toBe(bobNode)
		expect((await reopened.bindPrincipal('bob')).switched).toBe(false)
	})

	test('a pinned node id never moves: another user is a conflict', async () => {
		const { store } = await open({ nodeId: 'device-of-alice' })
		expect((await store.bindPrincipal('alice')).conflict).toBe(false)
		const binding = await store.bindPrincipal('bob')
		expect(binding).toMatchObject({ switched: false, conflict: true, nodeId: 'device-of-alice' })
		expect(store.getNodeId()).toBe('device-of-alice')
	})

	test('per-tab isolation: another user in this tab gets a fresh per-tab node', async () => {
		const { store, adapter } = await open({ isolation: 'per-tab' })
		await store.bindPrincipal('alice')
		const aliceTabNode = store.getNodeId()
		const binding = await store.bindPrincipal('bob')
		expect(binding.switched).toBe(true)
		expect(store.getNodeId()).not.toBe(aliceTabNode)
		expect(await principalOf(adapter, store.getNodeId())).toBe('bob')
		expect(await principalOf(adapter, aliceTabNode)).toBe('alice')
	})

	test('the legacy unkeyed node token stays with the node it belonged to', async () => {
		const { store, adapter } = await open()
		const aliceNode = store.getNodeId()
		await store.bindPrincipal('alice')
		await adapter.execute('INSERT OR REPLACE INTO _kora_meta (key, value) VALUES (?, ?)', [
			NODE_TOKEN_META_KEY,
			'alice-token',
		])
		await store.bindPrincipal('bob')
		expect(await loadNodeToken(adapter, store.getNodeId())).toBeNull()
		expect(await loadNodeToken(adapter, aliceNode)).toBe('alice-token')
		const keyed = await adapter.query<{ value: string }>(
			'SELECT value FROM _kora_meta WHERE key = ?',
			[nodeTokenKey(aliceNode)],
		)
		expect(keyed[0]?.value).toBe('alice-token')
	})
})

describe('local node registry migration and adoption schedule', () => {
	test('a registry table from an earlier release gains the principal and binding columns', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		await adapter.open(schema)
		await adapter.execute(`CREATE TABLE ${LOCAL_NODES_TABLE} (
  node_id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL,
  accepted INTEGER NOT NULL DEFAULT 0,
  held INTEGER NOT NULL DEFAULT 0,
  refused_cycle INTEGER
)`)
		await adapter.execute(
			`INSERT INTO ${LOCAL_NODES_TABLE} (node_id, created_at, accepted, held, refused_cycle) VALUES ('old', 1, 1, 0, NULL)`,
		)
		await ensureLocalSyncRecordTables(adapter)
		expect(await listLocalNodes(adapter)).toEqual([
			{
				nodeId: 'old',
				createdAt: 1,
				accepted: true,
				held: false,
				refusedCycle: null,
				principal: null,
				binding: null,
				refusedPrincipals: [],
			},
		])
		await adapter.close()
	})

	test('the adoption schedule round-trips and defaults to empty', async () => {
		const { adapter } = await open()
		expect(await loadAdoptionSchedule(adapter)).toEqual({ progress: 0, parked: {} })
		const schedule = {
			progress: 3,
			parked: { n1: { progressMark: 2, untilMs: 10, count: 1, parkedAtMs: 5 } },
		}
		await saveAdoptionSchedule(adapter, schedule)
		expect(await loadAdoptionSchedule(adapter)).toEqual(schedule)
		await adapter.execute(
			"UPDATE _kora_meta SET value = 'not json' WHERE key LIKE 'sync_adoption%'",
		)
		expect(await loadAdoptionSchedule(adapter)).toEqual({ progress: 0, parked: {} })
	})
})

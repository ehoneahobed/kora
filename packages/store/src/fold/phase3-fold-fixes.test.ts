/**
 * Phase 3 red-team fixes in the client store (RT-63, RT-66, RT-68, RT-69, RT-61's
 * client half): fold plan changes, backup fold state, row snapshots, provisional
 * side effects and reserved node ids.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	HybridLogicalClock,
	createOperation,
	createVersionVector,
	defineSchema,
	foldRecord,
	migrate,
	serializeFoldState,
	t,
} from '@korajs/core'
import type { Operation, SchemaDefinition } from '@korajs/core'
import { afterAll, afterEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'
import {
	FOLD_BASE_TABLE,
	FOLD_SNAPSHOT_TABLE,
	FOLD_STATE_TABLE,
	PROVISIONAL_OPS_TABLE,
	mergeYjsUpdates,
} from './record-folder'

const dir = mkdtempSync(join(tmpdir(), 'kora-phase3-fold-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const v1 = defineSchema({
	version: 1,
	collections: {
		items: {
			fields: {
				title: t.string(),
				score: t.number().default(0),
				tags: t.array(t.string()).default([]),
			},
		},
	},
}) as unknown as SchemaDefinition

const v2 = defineSchema({
	version: 2,
	collections: {
		items: {
			fields: {
				title: t.string(),
				score: t.number().default(0).merge('counter'),
				tags: t.array(t.string()).default([]),
			},
		},
	},
	migrations: { 2: migrate().backfill('items', () => ({})) },
}) as unknown as SchemaDefinition

const T0 = Date.now() - 60_000
let seq = 0
async function remote(
	node: string,
	wall: number,
	type: Operation['type'],
	data: Record<string, unknown> | null,
	previousData: Record<string, unknown> | null = null,
	extra: { recordId?: string; collection?: string; causalDeps?: string[] } = {},
): Promise<Operation> {
	seq += 1
	return createOperation(
		{
			nodeId: node,
			type,
			collection: extra.collection ?? 'items',
			recordId: extra.recordId ?? 'rec-1',
			data,
			previousData,
			sequenceNumber: seq,
			causalDeps: extra.causalDeps ?? [],
			schemaVersion: 1,
		},
		new HybridLogicalClock(node, { now: () => wall } as never),
	)
}

const stores: Store[] = []
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close()
})

async function open(schema: SchemaDefinition, name: string, nodeId?: string): Promise<Store> {
	const store = new Store({
		schema,
		adapter: new BetterSqlite3Adapter(name),
		...(nodeId ? { nodeId } : {}),
	})
	stores.push(store)
	await store.open()
	return store
}

async function count(store: Store, table: string): Promise<number> {
	const adapter = (store as unknown as { adapter: BetterSqlite3Adapter }).adapter
	const rows = await adapter.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
	return rows[0]?.n ?? 0
}

function adapterOf(store: Store): BetterSqlite3Adapter {
	return (store as unknown as { adapter: BetterSqlite3Adapter }).adapter
}

describe('RT-63: a schema change of a field fold kind', () => {
	test('re-folds on open; local and remote writes fold with the new plan', async () => {
		const path = join(dir, 'rt63-open.db')
		const a = await open(v1, path)
		const item = await a.collection('items').insert({ title: 'x', score: 1 })
		await a.collection('items').update(String(item.id), { score: 2 })
		await a.close()
		stores.splice(0)

		const b = await open(v2, path)
		// Stored states hold `score` as a counter now.
		const state = await b.getFoldState('items', String(item.id))
		expect(state?.f.score?.k).toBe('ctr')
		// A remote increment folds as a counter delta.
		const inc = await remote(
			'peer',
			T0 + 10,
			'update',
			{ score: 5 },
			{ score: 2 },
			{
				recordId: String(item.id),
			},
		)
		expect(await b.applyRemoteOperation(inc)).toBe('applied')
		await b.collection('items').update(String(item.id), { score: 6 })
		expect(await b.collection('items').findById(String(item.id))).toMatchObject({ score: 6 })
	})

	test('a stale stored state is re-folded on the write path (no FoldStateError)', async () => {
		const store = await open(v2, ':memory:')
		const item = await store.collection('items').insert({ title: 'x', score: 1 })
		// Plant a state of the old kind, as a database folded with v1 would hold.
		const ins = (await store.getOperationsForRecord('items', String(item.id)))[0] as Operation
		const stale = foldRecord([ins], v1).state
		await adapterOf(store).execute(`UPDATE ${FOLD_STATE_TABLE} SET state = ? WHERE record_id = ?`, [
			serializeFoldState(stale as NonNullable<typeof stale>),
			String(item.id),
		])
		const inc = await remote(
			'peer',
			Date.now() + 5,
			'update',
			{ score: 3 },
			{ score: 1 },
			{
				recordId: String(item.id),
			},
		)
		expect(await store.applyRemoteOperation(inc)).toBe('applied')
		expect(await store.collection('items').findById(String(item.id))).toMatchObject({ score: 3 })
		expect((await store.getFoldState('items', String(item.id)))?.f.score?.k).toBe('ctr')
	})

	test('a compacted base of the old kind is adapted (compacted history kept)', async () => {
		const path = join(dir, 'rt63-base.db')
		const a = await open(v1, path, 'phone')
		const item = await a.collection('items').insert({ title: 'x', score: 4, tags: ['a'] })
		const acked = createVersionVector()
		acked.set('phone', 1)
		expect((await a.compact({ mode: 'after-ack', serverVector: acked })).deletedCount).toBe(1)
		await a.close()
		stores.splice(0)

		const b = await open(v2, path, 'phone')
		expect(await b.collection('items').findById(String(item.id))).toMatchObject({
			title: 'x',
			score: 4,
			tags: ['a'],
		})
		const inc = await remote(
			'peer',
			Date.now() + 1,
			'update',
			{ score: 9 },
			{ score: 4 },
			{
				recordId: String(item.id),
			},
		)
		await b.applyRemoteOperation(inc)
		expect(await b.collection('items').findById(String(item.id))).toMatchObject({ score: 9 })
	})
})

describe('RT-66: backups carry the fold base states', () => {
	async function compactedPhone(): Promise<{ backup: Uint8Array; id: string }> {
		const phone = await open(v1, ':memory:', 'old-phone')
		const notes = phone.collection('items')
		const item = await notes.insert({ title: 'compacted', score: 1 })
		await notes.update(String(item.id), { score: 2 })
		const acked = createVersionVector()
		acked.set('old-phone', 2)
		await phone.compact({ mode: 'after-ack', serverVector: acked })
		await notes.update(String(item.id), { title: 'renamed' })
		return { backup: await phone.exportBackup(), id: String(item.id) }
	}

	test('merge mode on another device keeps compacted history', async () => {
		const { backup, id } = await compactedPhone()
		const other = await open(v1, ':memory:', 'new-phone')
		await other.collection('items').insert({ title: 'mine' })
		const result = await other.importBackup(backup, { merge: true })
		expect(result.success).toBe(true)
		expect(await other.collection('items').findById(id)).toMatchObject({
			title: 'renamed',
			score: 2,
		})
		expect(await other.collection('items').where({ title: 'mine' }).count()).toBe(1)
	})

	test('a collection-filtered replace keeps the bases of that collection', async () => {
		const { backup, id } = await compactedPhone()
		const other = await open(v1, ':memory:', 'new-phone')
		const result = await other.importBackup(backup, { collections: ['items'] })
		expect(result.success).toBe(true)
		expect(await other.collection('items').findById(id)).toMatchObject({
			title: 'renamed',
			score: 2,
		})
		expect(await count(other, FOLD_BASE_TABLE)).toBe(1)
	})

	test('a backup without fold state (earlier release) is rebuilt on its rows', async () => {
		const { backup, id } = await compactedPhone()
		// Strip the fold sections, as a file from an earlier release lacks them.
		const { parseBackup } = await import('../backup/backup')
		const parsed = await parseBackup(backup)
		const legacy = await rewriteWithoutFoldState(backup)
		expect(parsed.foldBases.length).toBe(1)
		const other = await open(v1, ':memory:', 'new-phone')
		const result = await other.importBackup(legacy)
		expect(result.success).toBe(true)
		expect(await other.collection('items').findById(id)).toMatchObject({
			title: 'renamed',
			score: 2,
		})
		expect(await count(other, FOLD_SNAPSHOT_TABLE)).toBe(1)
	})
})

/** Re-encode a backup without its fold sections and manifest flags (an older file). */
async function rewriteWithoutFoldState(data: Uint8Array): Promise<Uint8Array> {
	const sections: Array<{ name: string; content: Uint8Array }> = []
	const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
	let offset = 0
	while (offset + 8 <= data.byteLength) {
		const nameLen = dv.getUint32(offset, true)
		const contentLen = dv.getUint32(offset + 4, true)
		offset += 8
		const name = new TextDecoder().decode(data.slice(offset, offset + nameLen))
		offset += nameLen
		sections.push({ name, content: data.slice(offset, offset + contentLen) })
		offset += contentLen
	}
	const encode = (name: string, content: Uint8Array): Uint8Array => {
		const nameBytes = new TextEncoder().encode(name)
		const out = new Uint8Array(8 + nameBytes.length + content.length)
		const view = new DataView(out.buffer)
		view.setUint32(0, nameBytes.length, true)
		view.setUint32(4, content.length, true)
		out.set(nameBytes, 8)
		out.set(content, 8 + nameBytes.length)
		return out
	}
	const concat = (parts: Uint8Array[]): Uint8Array => {
		const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
		let at = 0
		for (const p of parts) {
			out.set(p, at)
			at += p.length
		}
		return out
	}
	const dropped = new Set(['fold_base', 'fold_snapshot', 'compacted_through'])
	const body = concat(
		sections
			.filter((s) => s.name !== 'manifest' && s.name !== 'checksum' && !dropped.has(s.name))
			.map((s) => encode(s.name, s.content)),
	)
	const digest = await globalThis.crypto.subtle.digest('SHA-256', body.buffer as ArrayBuffer)
	const checksum = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(
		'',
	)
	const manifestSection = sections.find((s) => s.name === 'manifest') as { content: Uint8Array }
	const manifest = JSON.parse(new TextDecoder().decode(manifestSection.content)) as Record<
		string,
		unknown
	>
	manifest.includesFoldState = undefined
	manifest.compacted = undefined
	manifest.checksum = checksum
	return concat([
		encode('manifest', new TextEncoder().encode(JSON.stringify(manifest))),
		body,
		encode('checksum', new TextEncoder().encode(checksum)),
	])
}

describe('RT-68: row snapshots', () => {
	test('a scope entry carrying the server fold state replaces the row snapshot exactly', async () => {
		const store = await open(v1, ':memory:', 'dev')
		const insert = await remote('a', T0, 'insert', { title: 'x', score: 10, tags: ['x'] })
		const restock = await remote(
			'a',
			T0 + 300,
			'update',
			{ score: 15, tags: ['x', 'y'] },
			{ score: 10, tags: ['x'] },
		)
		await store.applyRemoteOperation(insert)
		await store.applyRemoteOperation(restock)
		// Turn the record into a row snapshot (as 'snapshot+log' / 'kept' do).
		const { snapshotFromRow } = await import('./rematerialize')
		const adapter = adapterOf(store)
		const row = (await adapter.query<Record<string, unknown>>('SELECT * FROM items'))[0]
		const snapshot = snapshotFromRow(row as never, 'items', v1)
		await adapter.execute('DELETE FROM _kora_ops_items')
		await adapter.execute(
			`INSERT INTO ${FOLD_SNAPSHOT_TABLE} (collection, record_id, state) VALUES ('items', 'rec-1', ?)`,
			[JSON.stringify(snapshot)],
		)
		await adapter.execute(`UPDATE ${FOLD_STATE_TABLE} SET state = ?`, [JSON.stringify(snapshot)])
		expect(await store.getSnapshotRecords()).toEqual([{ collection: 'items', recordId: 'rec-1' }])

		// A late, older array add is lost on the snapshot (the documented residual)...
		const late = await remote('b', T0 + 200, 'update', { tags: ['x', 'z'] }, { tags: ['x'] })
		await store.applyRemoteOperation(late)
		expect((await store.collection('items').findById('rec-1'))?.tags).toEqual(['x', 'y'])

		// ...until the server's fold state arrives in a scope entry.
		const server = foldRecord([insert, restock, late], v1, { richtext: mergeYjsUpdates }).state
		const entry: Operation = {
			id: 'scope-entry-rt68',
			nodeId: 'kora:scope-entry',
			type: 'insert',
			collection: 'items',
			recordId: 'rec-1',
			data: { title: 'x', score: 15, tags: ['x', 'z', 'y'] },
			previousData: null,
			timestamp: insert.timestamp,
			sequenceNumber: 0,
			causalDeps: [],
			schemaVersion: 1,
			foldState: serializeFoldState(server as NonNullable<typeof server>),
		}
		await store.applyRemoteOperation(entry)
		expect(await store.collection('items').findById('rec-1')).toMatchObject({
			score: 15,
			tags: ['x', 'z', 'y'],
		})
		expect(await store.getSnapshotRecords()).toEqual([])
	})

	test('only the record that owns a quarantined row is kept as a snapshot', async () => {
		const path = join(dir, 'rt68-kept.db')
		const a = await open(v1, path, 'dev')
		const one = await a.collection('items').insert({ title: 'one' })
		const two = await a.collection('items').insert({ title: 'two' })
		await a.collection('items').update(String(two.id), { title: 'two!' })
		const adapter = adapterOf(a)
		// Damage one operation row of `one` (unrecoverable timestamp) and force a
		// re-materialization on the next open.
		await adapter.execute(`UPDATE _kora_ops_items SET timestamp = 'garbage' WHERE record_id = ?`, [
			String(one.id),
		])
		await adapter.execute(`DELETE FROM _kora_meta WHERE key = 'fold_materialization'`)
		await a.close()
		stores.splice(0)

		const b = await open(v1, path, 'dev')
		expect(await b.getSnapshotRecords()).toEqual([
			{ collection: 'items', recordId: String(one.id) },
		])
		expect(await b.collection('items').findById(String(one.id))).toMatchObject({ title: 'one' })
		expect(await b.collection('items').findById(String(two.id))).toMatchObject({ title: 'two!' })
	})

	test('after a full resync the snapshot is dropped once the insert is back', async () => {
		const store = await open(v1, ':memory:', 'dev')
		const insert = await remote('a', T0, 'insert', { title: 'x', score: 1 })
		await store.applyRemoteOperation(insert)
		const { snapshotFromRow } = await import('./rematerialize')
		const adapter = adapterOf(store)
		const row = (await adapter.query<Record<string, unknown>>('SELECT * FROM items'))[0]
		await adapter.execute(
			`INSERT INTO ${FOLD_SNAPSHOT_TABLE} (collection, record_id, state) VALUES ('items', 'rec-1', ?)`,
			[JSON.stringify(snapshotFromRow(row as never, 'items', v1))],
		)
		await adapter.execute(
			`INSERT OR REPLACE INTO _kora_meta (key, value) VALUES ('fold_snapshot_resync', 'pending')`,
		)
		expect(await store.settleAfterCatchUp()).toBe(1)
		expect(await store.getSnapshotRecords()).toEqual([])
		expect(await store.collection('items').findById('rec-1')).toMatchObject({ score: 1 })
	})
})

describe('RT-69: provisional cascades of a remote delete', () => {
	const relational = defineSchema({
		version: 1,
		collections: {
			projects: { fields: { name: t.string() } },
			tasks: { fields: { title: t.string(), projectId: t.string() } },
		},
		relations: {
			taskProject: {
				from: 'tasks',
				to: 'projects',
				type: 'many-to-one',
				field: 'projectId',
				onDelete: 'cascade',
			},
		},
	}) as unknown as SchemaDefinition

	test('are folded but never logged or queued, and retire on the real copy', async () => {
		const store = await open(relational, ':memory:', 'dev')
		const project = await remote('a', T0, 'insert', { name: 'p' }, null, {
			collection: 'projects',
			recordId: 'p1',
		})
		const task = await remote('a', T0 + 1, 'insert', { title: 't', projectId: 'p1' }, null, {
			collection: 'tasks',
			recordId: 't1',
		})
		await store.applyRemoteOperation(project)
		await store.applyRemoteOperation(task)
		const del = await remote('a', T0 + 2, 'delete', null, null, {
			collection: 'projects',
			recordId: 'p1',
		})
		await store.applyRemoteOperation(del)
		const before = (await store.getAllOperations()).length
		await store.applyProvisionalSideEffects(del, [
			{
				type: 'delete',
				collection: 'tasks',
				recordId: 't1',
				data: null,
				previousData: null,
				ruleId: 'relation:taskProject:cascade',
			},
		])
		expect(await store.collection('tasks').findById('t1')).toBeNull()
		expect((await store.getAllOperations()).length).toBe(before)
		expect(await count(store, PROVISIONAL_OPS_TABLE)).toBe(1)
		const queued = await store.getUnsyncedOperations(createVersionVector())
		expect(queued.filter((op) => op.collection === 'tasks' && op.type === 'delete')).toEqual([])

		// The server's copy (same parent) retires the provisional effect.
		const serverCopy = await remote('kora:server:main', T0 + 3, 'delete', null, null, {
			collection: 'tasks',
			recordId: 't1',
			causalDeps: [del.id],
		})
		await store.applyRemoteOperation(serverCopy)
		expect(await count(store, PROVISIONAL_OPS_TABLE)).toBe(0)
		expect(await store.collection('tasks').findById('t1')).toBeNull()
	})

	test('an effect the server never derived is retired after catch-up', async () => {
		const store = await open(relational, ':memory:', 'dev')
		const project = await remote('a', T0, 'insert', { name: 'p' }, null, {
			collection: 'projects',
			recordId: 'p1',
		})
		const task = await remote('a', T0 + 1, 'insert', { title: 't', projectId: 'p1' }, null, {
			collection: 'tasks',
			recordId: 't1',
		})
		const del = await remote('a', T0 + 2, 'delete', null, null, {
			collection: 'projects',
			recordId: 'p1',
		})
		for (const op of [project, task, del]) await store.applyRemoteOperation(op)
		await store.applyProvisionalSideEffects(del, [
			{
				type: 'delete',
				collection: 'tasks',
				recordId: 't1',
				data: null,
				previousData: null,
				ruleId: 'relation:taskProject:cascade',
			},
		])
		expect(await store.collection('tasks').findById('t1')).toBeNull()
		await store.settleAfterCatchUp()
		expect(await count(store, PROVISIONAL_OPS_TABLE)).toBe(0)
		expect(await store.collection('tasks').findById('t1')).toMatchObject({ title: 't' })
	})

	test('a provisional table of a pre-release build (durable column) still works; every effect retires at catch-up', async () => {
		// RT-74/78/82 redesign: sealed relation fields are refused at app init, so no effect
		// is durable any more; a database whose table has the old column keeps working.
		const path = join(dir, 'old-durable-provisional.db')
		const raw = new BetterSqlite3Adapter(path)
		await raw.open(relational)
		await raw.execute(
			`CREATE TABLE ${PROVISIONAL_OPS_TABLE} (id TEXT PRIMARY KEY, collection TEXT NOT NULL, record_id TEXT NOT NULL, parent_id TEXT NOT NULL, operation TEXT NOT NULL, durable INTEGER NOT NULL DEFAULT 0)`,
		)
		await raw.close()
		const store = await open(relational, path, 'dev')
		const project = await remote('a', T0, 'insert', { name: 'p' }, null, {
			collection: 'projects',
			recordId: 'p1',
		})
		const task = await remote('b', T0 + 1, 'insert', { title: 't', projectId: 'p1' }, null, {
			collection: 'tasks',
			recordId: 't1',
		})
		const del = await remote('a', T0 + 2, 'delete', null, null, {
			collection: 'projects',
			recordId: 'p1',
		})
		for (const op of [project, task, del]) await store.applyRemoteOperation(op)
		await store.applyProvisionalSideEffects(del, [
			{
				type: 'delete',
				collection: 'tasks',
				recordId: 't1',
				data: null,
				previousData: null,
				ruleId: 'relation:taskProject:cascade',
			},
		])
		expect(await store.collection('tasks').findById('t1')).toBeNull()
		await store.settleAfterCatchUp()
		expect(await count(store, PROVISIONAL_OPS_TABLE)).toBe(0)
		expect(await store.collection('tasks').findById('t1')).toMatchObject({ title: 't' })
		await store.close()
	})
})

describe('reserved node ids (RT-61, client half)', () => {
	test('a configured kora: node id is refused', async () => {
		const store = new Store({
			schema: v1,
			adapter: new BetterSqlite3Adapter(':memory:'),
			nodeId: 'kora:server:main',
		})
		await expect(store.open()).rejects.toMatchObject({ code: 'RESERVED_NODE_ID' })
	})

	test('a persisted kora: node id is never adopted', async () => {
		const path = join(dir, 'reserved.db')
		const a = await open(v1, path)
		await adapterOf(a).execute(
			"UPDATE _kora_meta SET value = 'kora:server:x' WHERE key = 'node_id'",
		)
		await a.close()
		stores.splice(0)
		const b = await open(v1, path)
		expect(b.getNodeId().startsWith('kora:')).toBe(false)
	})
})

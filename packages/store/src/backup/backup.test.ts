import { HybridLogicalClock, createOperation, defineSchema, op, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'
import { BACKUP_VERSION, convertBackupV1, parseBackup, readBackupManifest } from './backup'

/** STORE-5: canonical backups that restore without corrupting the log or copying identity. */
const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				count: t.number().default(0),
				done: t.boolean().default(false),
				tags: t.array(t.string()).default([]),
			},
		},
	},
})

const stores: Store[] = []
afterEach(async () => {
	for (const store of stores.splice(0)) await store.close()
})

async function open(nodeId?: string): Promise<{ store: Store; adapter: BetterSqlite3Adapter }> {
	const adapter = new BetterSqlite3Adapter(':memory:')
	const store = new Store({ schema, adapter, ...(nodeId ? { nodeId } : {}) })
	await store.open()
	stores.push(store)
	return { store, adapter }
}

async function seeded(): Promise<{ store: Store; adapter: BetterSqlite3Adapter; id: string }> {
	const opened = await open()
	const todos = opened.store.collection('todos')
	const record = await todos.insert({ title: 'a', tags: ['x'] })
	await todos.update(record.id, { count: op.increment(2) })
	const gone = await todos.insert({ title: 'gone' })
	await todos.delete(gone.id)
	await opened.store.transaction(async (tx) => {
		await tx.collection('todos').update(record.id, { title: 'b' })
	})
	return { ...opened, id: record.id }
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value))
const meta = async (adapter: BetterSqlite3Adapter, key: string) =>
	(await adapter.query<{ value: string }>('SELECT value FROM _kora_meta WHERE key = ?', [key]))[0]
		?.value
const vector = async (adapter: BetterSqlite3Adapter, nodeId: string) =>
	(
		await adapter.query<{ sequence_number: number }>(
			'SELECT sequence_number FROM _kora_version_vector WHERE node_id = ?',
			[nodeId],
		)
	)[0]?.sequence_number

describe('exportBackup (format 2)', () => {
	test('exports canonical operations in HLC order and every row, tombstones included', async () => {
		const { store } = await seeded()
		const data = await store.exportBackup()
		const manifest = readBackupManifest(data)
		expect(manifest).toMatchObject({ version: BACKUP_VERSION, includesTombstones: true })
		const parsed = await parseBackup(data)
		expect(plain(parsed.operations)).toEqual(
			plain(
				[...(await store.getAllOperations())].sort((a, b) =>
					HybridLogicalClock.compare(a.timestamp, b.timestamp),
				),
			),
		)
		expect(parsed.operations.some((o) => o.atomicOps?.count)).toBe(true)
		expect(parsed.operations.some((o) => o.transactionId !== undefined)).toBe(true)
		const rows = parsed.records.get('todos') ?? []
		expect(rows.map((r) => r._deleted).sort()).toEqual([0, 1])
		// No device identity or sync state in the file.
		expect(new TextDecoder().decode(data)).not.toContain('"node_id"')
	})
})

describe('importBackup replace mode', () => {
	test('an exact round trip on a database that never synced (keepUnsyncedWrites: false)', async () => {
		const { store } = await seeded()
		const before = plain(await store.getAllOperations())
		const rows = plain(await store.collection('todos').where({}).exec())
		const result = await store.importBackup(await store.exportBackup(), {
			keepUnsyncedWrites: false,
		})
		expect(result).toMatchObject({ success: true, unsyncedWritesKept: 0 })
		expect(plain(await store.getAllOperations())).toEqual(before)
		expect(plain(await store.collection('todos').where({}).exec())).toEqual(rows)
		expect((await store.verifyLogIntegrity()).clean).toBe(true)
	})

	test("a backup from another device never copies its identity; this device's writes are kept", async () => {
		const a = await seeded()
		const b = await open()
		const bNode = b.store.getNodeId()
		const mine = await b.store.collection('todos').insert({ title: 'only-on-b' })
		const seen: unknown[][] = []
		b.store
			.collection('todos')
			.where({})
			.subscribe((rows) => seen.push(rows.map((r) => r.title)))
		const result = await b.store.importBackup(await a.store.exportBackup())
		expect(result).toMatchObject({ success: true, unsyncedWritesKept: 1 })
		expect(b.store.getNodeId()).toBe(bNode)
		expect(await meta(b.adapter, 'node_id')).toBe(bNode)
		expect((await b.store.listLocalNodes()).map((n) => n.nodeId)).toEqual([bNode])
		expect(await b.store.collection('todos').findById(mine.id)).toMatchObject({
			title: 'only-on-b',
		})
		expect(await vector(b.adapter, bNode)).toBe(1)
		// Live queries re-ran with the restored data.
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(seen.at(-1)?.sort()).toEqual(['b', 'only-on-b'])
		// The next write sorts after everything restored and continues B's own sequence.
		const next = await b.store.collection('todos').insert({ title: 'after' })
		const ops = await b.store.getAllOperations()
		const created = ops.find((o) => o.recordId === next.id) as Operation
		expect(created.sequenceNumber).toBe(2)
		for (const other of ops) {
			if (other.id !== created.id) {
				expect(HybridLogicalClock.compare(created.timestamp, other.timestamp)).toBeGreaterThan(0)
			}
		}
		expect((await b.store.verifyLogIntegrity()).clean).toBe(true)
	})

	test('own counters never move backwards; an unsynced node restarts contiguously', async () => {
		const { store, adapter } = await open()
		const node = store.getNodeId()
		await store.collection('todos').insert({ title: 'one' })
		const backup = await store.exportBackup()
		await store.collection('todos').insert({ title: 'two' })
		await store.collection('todos').insert({ title: 'three' })
		expect(await vector(adapter, node)).toBe(3)

		// Never accepted, unsynced writes dropped: the counter restarts after the backup's.
		await store.importBackup(backup, { keepUnsyncedWrites: false })
		expect(await vector(adapter, node)).toBe(1)
		await store.collection('todos').insert({ title: 'four' })
		expect(await vector(adapter, node)).toBe(2)
		expect((await store.verifyLogIntegrity()).gaps).toEqual([])
	})

	test("an accepted node's unacknowledged writes are always kept and its counter never drops", async () => {
		const { store, adapter } = await open()
		const node = store.getNodeId()
		await store.collection('todos').insert({ title: 'acked' })
		await store.markLocalNodeAccepted(node)
		await store.saveOwnAckedThrough(node, 1)
		const backup = await store.exportBackup()
		await store.collection('todos').insert({ title: 'in-flight' })
		const result = await store.importBackup(backup, { keepUnsyncedWrites: false })
		expect(result.unsyncedWritesKept).toBe(1)
		expect(await vector(adapter, node)).toBe(2)
		expect((await store.collection('todos').where({}).exec()).map((r) => r.title).sort()).toEqual([
			'acked',
			'in-flight',
		])
		expect((await store.verifyLogIntegrity()).clean).toBe(true)
	})

	test('delivery watermarks restart at 0 and the delta cursor is dropped; tokens stay', async () => {
		const { store, adapter } = await seeded()
		await store.saveDeliveryWatermark('', 42)
		await store.saveDeliveryWatermark('view-a', 7)
		await store.saveDeltaCursor('cursor')
		await store.saveNodeToken('token-of-this-device')
		await store.importBackup(await store.exportBackup())
		expect(await store.loadAllDeliveryWatermarks()).toEqual({ '': 0, 'view-a': 0 })
		expect(await store.loadDeltaCursor()).toBeNull()
		expect(await store.loadNodeToken()).toBe('token-of-this-device')
		expect(await meta(adapter, 'schema_version')).toBe('1')
	})
})

describe('importBackup merge mode', () => {
	test('applies the operations, keeps identity, MAXes the vector, imports nothing of sync meta', async () => {
		const a = await seeded()
		await a.store.saveNodeToken('token-of-a')
		await a.store.recordTerminalRejections([
			{
				operationId: 'refused-op',
				nodeId: 'x',
				sequenceNumber: 1,
				code: 'FORBIDDEN',
				rejectedAt: 1,
			},
		])
		const b = await open()
		const bNode = b.store.getNodeId()
		await b.store.collection('todos').insert({ title: 'b1' })
		await b.store.collection('todos').insert({ title: 'b2' })
		const result = await b.store.importBackup(await a.store.exportBackup(), { merge: true })
		expect(result.success).toBe(true)
		expect(await meta(b.adapter, 'node_id')).toBe(bNode)
		expect(await b.store.loadNodeToken(a.store.getNodeId())).toBeNull()
		expect(await vector(b.adapter, bNode)).toBe(2)
		expect(await vector(b.adapter, a.store.getNodeId())).toBe(
			a.store.getVersionVector().get(a.store.getNodeId()),
		)
		expect((await b.store.findTerminalRejections(['refused-op'])).has('refused-op')).toBe(true)
		expect((await b.store.collection('todos').where({}).exec()).map((r) => r.title).sort()).toEqual(
			['b', 'b1', 'b2'],
		)
		const restored = await b.store.collection('todos').findById(a.id)
		expect(restored).toMatchObject({ title: 'b', count: 2, tags: ['x'] })
		// Importing twice changes nothing.
		const again = await b.store.importBackup(await a.store.exportBackup(), { merge: true })
		expect(again.operationsRestored).toBe(0)
		expect((await b.store.verifyLogIntegrity()).clean).toBe(true)
	})

	test('operations of server-authority nodes are never applied from a file', async () => {
		const a = await seeded()
		const serverOp = async (nodeId: string, recordId: string): Promise<Operation> => {
			return createOperation(
				{
					nodeId,
					type: 'insert',
					collection: 'todos',
					recordId,
					data: { title: `from ${nodeId}` },
					previousData: null,
					sequenceNumber: 1,
					causalDeps: [],
					schemaVersion: 1,
				},
				new HybridLogicalClock(nodeId),
			)
		}
		await a.store.applyRemoteOperation(await serverOp('kora:server:dep:1', 'srv-1'))
		await a.store.applyRemoteOperation(await serverOp('legacy-srv', 'srv-2'))
		const b = await open()
		await b.store.setAuthoritativeNodeIds(['legacy-srv'])
		const result = await b.store.importBackup(await a.store.exportBackup(), { merge: true })
		expect(result).toMatchObject({ success: true, serverOperationsSkipped: 2 })
		expect(await b.store.collection('todos').findById('srv-1')).toBeNull()
		expect(await b.store.collection('todos').findById('srv-2')).toBeNull()
		expect(await vector(b.adapter, 'kora:server:dep:1')).toBeUndefined()
		expect(await vector(b.adapter, 'legacy-srv')).toBeUndefined()
		// The device's own data still merges.
		expect(await b.store.collection('todos').findById(a.id)).toMatchObject({ title: 'b' })
	})
})

describe('format checks and version-1 conversion', () => {
	test('a corrupted file, or one from a newer schema, is refused before anything changes', async () => {
		const { store } = await seeded()
		const data = await store.exportBackup()
		const broken = data.slice()
		// A byte of the last content section (just before the 80-byte checksum section).
		const at = broken.length - 100
		broken[at] = (broken[at] ?? 0) ^ 0xff
		expect(await store.importBackup(broken)).toMatchObject({
			success: false,
			errorCode: 'BACKUP_CHECKSUM_MISMATCH',
		})
		const newer = await open()
		const v2 = defineSchema({
			...{ version: 2 },
			collections: { todos: { fields: { title: t.string() } } },
		})
		const newerStore = new Store({ schema: v2, adapter: new BetterSqlite3Adapter(':memory:') })
		await newerStore.open()
		stores.push(newerStore)
		expect(await newer.store.importBackup(await newerStore.exportBackup())).toMatchObject({
			success: false,
			errorCode: 'BACKUP_SCHEMA_NEWER',
		})
	})

	test('importBackup converts a version-1 file itself (F3); convertBackupV1 recovers it too', async () => {
		const { store, adapter } = await seeded()
		const ops = plain(await store.getAllOperations()) as Array<Record<string, unknown>>
		// The second operation as a v1 export of a damaged log saw it: wallTime misread.
		const damaged = ops[1] as { timestamp: { wallTime: number; logical: number; nodeId: string } }
		const original = damaged.timestamp
		const misread = HybridLogicalClock.deserialize(JSON.stringify(original))
		damaged.timestamp = plain(misread)
		expect(damaged.timestamp.wallTime).toBeNull()
		const rows = await adapter.query('SELECT * FROM todos WHERE _deleted = 0')
		const v1 = await buildV1Backup(store.getNodeId(), ops, rows)

		const direct = await open()
		const imported = await direct.store.importBackup(v1)
		expect(imported).toMatchObject({ success: true, convertedFromVersion: 1 })
		expect(direct.store.getNodeId()).not.toBe(store.getNodeId())
		const restored = await direct.store.getAllOperations()
		expect(restored.find((o) => o.id === (ops[1] as { id: string }).id)?.timestamp).toEqual(
			original,
		)
		expect((await direct.store.verifyLogIntegrity()).quarantined).toEqual([])

		const converted = await convertBackupV1(v1)
		expect(readBackupManifest(converted)).toMatchObject({
			version: 2,
			includesTombstones: false,
			convertedFrom: 1,
		})
		const parsed = await parseBackup(converted)
		expect(
			parsed.operations.find((o) => o.id === (ops[1] as { id: string }).id)?.timestamp,
		).toEqual(original)
		const target = await open()
		const result = await target.store.importBackup(converted)
		expect(result.success).toBe(true)
		expect(target.store.getNodeId()).not.toBe(store.getNodeId())
		expect((await target.store.verifyLogIntegrity()).quarantined).toEqual([])
	})

	test('an unrecoverable v1 operation refuses the conversion unless dropped explicitly', async () => {
		const { store } = await seeded()
		const ops = plain(await store.getAllOperations()) as Array<Record<string, unknown>>
		;(ops[0] as { timestamp: unknown }).timestamp = { wallTime: null, logical: 'x', nodeId: 1 }
		const v1 = await buildV1Backup(store.getNodeId(), ops, [])
		await expect(convertBackupV1(v1)).rejects.toThrow(/unrecoverable/)
		// importBackup never drops an operation on its own: it reports the refusal.
		const target = await open()
		const refused = await target.store.importBackup(v1)
		expect(refused).toMatchObject({ success: false, errorCode: 'BACKUP_OPERATION_INVALID' })
		expect(refused.error).toMatch(/dropUnrecoverable/)
		const converted = await convertBackupV1(v1, { dropUnrecoverable: true })
		expect(readBackupManifest(converted).operationCount).toBe(ops.length - 1)
	})
})

/** A file in the version-1 layout (manifest, version_vector, meta, operations, records). */
async function buildV1Backup(nodeId: string, ops: unknown[], rows: unknown[]): Promise<Uint8Array> {
	const section = (name: string, text: string): Uint8Array => {
		const n = new TextEncoder().encode(name)
		const c = new TextEncoder().encode(text)
		const out = new Uint8Array(8 + n.length + c.length)
		const dv = new DataView(out.buffer)
		dv.setUint32(0, n.length, true)
		dv.setUint32(4, c.length, true)
		out.set(n, 8)
		out.set(c, 8 + n.length)
		return out
	}
	const join = (parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
		const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
		let at = 0
		for (const p of parts) {
			out.set(p, at)
			at += p.length
		}
		return out
	}
	const body = join([
		section('version_vector', JSON.stringify({ [nodeId]: ops.length })),
		section('meta', JSON.stringify({ node_id: nodeId, sync_node_token: 'secret' })),
		section('operations', `${ops.map((o) => JSON.stringify(o)).join('\n')}\n`),
		...(rows.length > 0
			? [section('records:todos', `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`)]
			: []),
	])
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(body)))
	const checksum = Array.from(digest)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')
	const manifest = {
		version: 1,
		createdAt: 1,
		nodeId,
		schemaVersion: 1,
		operationCount: ops.length,
		collections: ['todos'],
		includesRecords: rows.length > 0,
		checksum,
	}
	return join([section('manifest', JSON.stringify(manifest)), body, section('checksum', checksum)])
}

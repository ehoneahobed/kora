import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HybridLogicalClock, createOperation, defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { computeOperationId } from '@korajs/core/internal'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { buildInsertQuery } from '../query/sql-builder'
import { serializeOperation } from '../serialization/serializer'
import { SEQ_CONFLICTS_TABLE, uniqueSequenceIndexName } from './sequence-repair'
import { Store } from './store'

/**
 * W6 step 2: a database written by beta.12 can hold several operations of one
 * node under the same sequence number (STORE-1/2), and a persisted counter
 * below the highest logged number. Opening it with this version must keep every
 * write, give this device's duplicates fresh numbers, and then enforce
 * uniqueness with an index.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string(), n: t.number().default(0) } },
		projects: { fields: { name: t.string() } },
	},
})

let tmpDir = ''
let counter = 0
beforeAll(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'kora-seq-repair-'))
})
afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true })
})
function nextDbPath(): string {
	counter++
	return join(tmpDir, `repair-${counter}.db`)
}

async function op(
	nodeId: string,
	fields: Partial<Parameters<typeof createOperation>[0]> & {
		type: Operation['type']
		collection: string
		recordId: string
		sequenceNumber: number
	},
): Promise<Operation> {
	return createOperation(
		{
			nodeId,
			data: null,
			previousData: null,
			causalDeps: [],
			schemaVersion: 1,
			...fields,
		},
		new HybridLogicalClock(nodeId),
		// beta.12 wrote version-1 ids (the sequence number is not hashed).
		{ hashVersion: 1 },
	)
}

async function writeRaw(adapter: BetterSqlite3Adapter, operation: Operation): Promise<void> {
	const q = buildInsertQuery(
		`_kora_ops_${operation.collection}`,
		serializeOperation(operation) as unknown as Record<string, unknown>,
	)
	await adapter.execute(q.sql, q.params)
}

/**
 * Build a database shaped like beta.12 output: duplicate sequence numbers for
 * this node (same table and across tables), duplicates for another node, no
 * unique index, and a counter that lags the log.
 */
async function createBeta12Database(
	path: string,
	options: { keepRepairFlag?: boolean } = {},
): Promise<{
	ownIds: string[]
	peerA: Operation
	peerB: Operation
}> {
	const store = new Store({ schema, adapter: new BetterSqlite3Adapter(path), nodeId: 'node-1' })
	await store.open()
	const a = await store.collection('todos').insert({ title: 'a' }) // seq 1
	const [aV2] = await store.getAllOperations()
	await store.close()

	const raw = new BetterSqlite3Adapter(path)
	await raw.open(schema)
	// Rewrite the store-made operation as beta.12 wrote it: a version-1 id.
	let aOp: Operation | undefined
	if (aV2) {
		const { hashVersion: _v2, ...legacy } = aV2
		aOp = { ...legacy, id: await computeOperationId(aV2, 1) }
		await raw.execute('DELETE FROM _kora_ops_todos WHERE id = ?', [aV2.id])
		await writeRaw(raw, aOp)
	}
	await raw.execute(`DROP INDEX IF EXISTS "${uniqueSequenceIndexName('todos')}"`)
	await raw.execute(`DROP INDEX IF EXISTS "${uniqueSequenceIndexName('projects')}"`)
	if (!options.keepRepairFlag) {
		await raw.execute("DELETE FROM _kora_meta WHERE key = 'seq_unique_repair_v1'")
	}

	// Same-table duplicate of seq 1 (two app.transaction calls racing).
	const b = await op('node-1', {
		type: 'insert',
		collection: 'todos',
		recordId: 'todo-b',
		data: { title: 'b', n: 0 },
		sequenceNumber: 1,
	})
	// Cross-table duplicate of seq 1 (cascade side effect reusing a number).
	const c = await op('node-1', {
		type: 'insert',
		collection: 'projects',
		recordId: 'project-c',
		data: { name: 'c' },
		sequenceNumber: 1,
	})
	// A later op the counter never covered.
	const d = await op('node-1', {
		type: 'update',
		collection: 'todos',
		recordId: a.id,
		data: { n: 5 },
		previousData: { n: 0 },
		atomicOps: { n: { type: 'increment', value: 5 } },
		sequenceNumber: 2,
	})
	// Another device's duplicate pair, both delivered by the server.
	const peerA = await op('peer', {
		type: 'update',
		collection: 'todos',
		recordId: a.id,
		data: { title: 'peer-a' },
		previousData: { title: 'a' },
		sequenceNumber: 7,
	})
	const peerB = await op('peer', {
		type: 'update',
		collection: 'todos',
		recordId: a.id,
		data: { title: 'peer-b' },
		previousData: { title: 'a' },
		sequenceNumber: 7,
	})
	for (const o of [b, c, d, peerA, peerB]) await writeRaw(raw, o)
	await raw.execute('UPDATE _kora_version_vector SET sequence_number = 1 WHERE node_id = ?', [
		'node-1',
	])
	await raw.execute('INSERT OR REPLACE INTO _kora_version_vector VALUES (?, ?)', ['peer', 7])
	await raw.close()
	return { ownIds: [aOp?.id ?? '', b.id, c.id, d.id].sort(), peerA, peerB }
}

describe('sequence uniqueness repair (W6)', () => {
	test('re-sequences own duplicates, keeps every write, then enforces uniqueness', async () => {
		const path = nextDbPath()
		const { ownIds, peerA, peerB } = await createBeta12Database(path)
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

		const adapter = new BetterSqlite3Adapter(path)
		const store = new Store({ schema, adapter, nodeId: 'node-1' })
		await store.open()
		try {
			expect(warn).toHaveBeenCalledTimes(1)

			// Every own write is still in the log, under its original id, with
			// unique contiguous numbers; the counter covers them.
			const own = (await store.getAllOperations()).filter((o) => o.nodeId === 'node-1')
			expect(own.map((o) => o.id).sort()).toEqual(ownIds)
			expect(own.map((o) => o.sequenceNumber).sort((x, y) => x - y)).toEqual([1, 2, 3, 4])
			expect(store.getVersionVector().get('node-1')).toBe(4)

			// The server acknowledged through 1 before the repair: everything else
			// (including both re-sequenced duplicates) is uploadable.
			const unsynced = await store.getUnsyncedOperations(
				new Map([
					['node-1', 1],
					['peer', 7],
				]),
			)
			expect(unsynced.map((o) => o.sequenceNumber)).toEqual([2, 3, 4])

			// Audit trail: two own rows re-emitted under their ids, one peer row kept.
			const audit = await adapter.query<{
				id: string
				node_id: string
				reemitted_as: string | null
				new_sequence_number: number | null
			}>(`SELECT id, node_id, reemitted_as, new_sequence_number FROM ${SEQ_CONFLICTS_TABLE}`)
			const ownAudit = audit.filter((row) => row.node_id === 'node-1')
			expect(ownAudit).toHaveLength(2)
			for (const row of ownAudit) {
				expect(row.reemitted_as).toBe(row.id)
				expect([3, 4]).toContain(row.new_sequence_number)
			}
			const peerAudit = audit.filter((row) => row.node_id === 'peer')
			expect(peerAudit).toHaveLength(1)
			expect(peerAudit[0]?.reemitted_as).toBeNull()

			// The peer operation kept only in the conflicts table still dedups and
			// still belongs to the record's history.
			expect(await store.applyRemoteOperation(peerA)).toBe('duplicate')
			expect(await store.applyRemoteOperation(peerB)).toBe('duplicate')
			const history = await store.getOperationsForRecord('todos', peerA.recordId)
			expect(history.map((o) => o.id)).toEqual(expect.arrayContaining([peerA.id, peerB.id]))

			// Uniqueness is now enforced.
			const indexes = await adapter.query<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'uidx_kora_ops_%'",
			)
			expect(indexes.map((r) => r.name).sort()).toEqual(
				[uniqueSequenceIndexName('projects'), uniqueSequenceIndexName('todos')].sort(),
			)

			// New writes continue after the repaired block.
			await store.collection('todos').insert({ title: 'after' })
			const after = (await store.getAllOperations()).find(
				(o) => (o.data as { title?: string } | null)?.title === 'after',
			)
			expect(after?.sequenceNumber).toBe(5)
		} finally {
			await store.close()
			warn.mockRestore()
		}

		// Re-opening is a no-op.
		const warnAgain = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const reopened = new Store({
			schema,
			adapter: new BetterSqlite3Adapter(path),
			nodeId: 'node-1',
		})
		await reopened.open()
		try {
			expect(warnAgain).not.toHaveBeenCalled()
			const seqs = (await reopened.getAllOperations())
				.filter((o) => o.nodeId === 'node-1')
				.map((o) => o.sequenceNumber)
				.sort((x, y) => x - y)
			expect(seqs).toEqual([1, 2, 3, 4, 5])
		} finally {
			await reopened.close()
			warnAgain.mockRestore()
		}
	})

	test('duplicates written after an earlier repair are repaired before the index is created', async () => {
		const path = nextDbPath()
		const { ownIds } = await createBeta12Database(path, { keepRepairFlag: true })
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const store = new Store({ schema, adapter: new BetterSqlite3Adapter(path), nodeId: 'node-1' })
		await store.open()
		try {
			const own = (await store.getAllOperations()).filter((o) => o.nodeId === 'node-1')
			expect(own.map((o) => o.id).sort()).toEqual(ownIds)
			expect(own.map((o) => o.sequenceNumber).sort((x, y) => x - y)).toEqual([1, 2, 3, 4])
		} finally {
			await store.close()
			warn.mockRestore()
		}
	})

	test('a remote operation whose number another op of its node holds is kept, not rejected', async () => {
		const adapter = new BetterSqlite3Adapter(':memory:')
		const store = new Store({ schema, adapter, nodeId: 'node-1' })
		await store.open()
		try {
			const first = await op('peer', {
				type: 'insert',
				collection: 'todos',
				recordId: 'r1',
				data: { title: 'one', n: 0 },
				sequenceNumber: 3,
			})
			const clash = await op('peer', {
				type: 'insert',
				collection: 'todos',
				recordId: 'r2',
				data: { title: 'two', n: 0 },
				sequenceNumber: 3,
			})
			expect(await store.applyRemoteOperation(first)).toBe('applied')
			expect(await store.applyRemoteOperation(clash)).toBe('applied')
			expect((await store.collection('todos').findById('r2'))?.title).toBe('two')
			expect(await store.applyRemoteOperation(clash)).toBe('duplicate')
			const retained = await adapter.query<{ id: string; reason: string }>(
				`SELECT id, reason FROM ${SEQ_CONFLICTS_TABLE}`,
			)
			expect(retained).toEqual([{ id: clash.id, reason: 'remote-sequence-conflict' }])
		} finally {
			await store.close()
		}
	})
})

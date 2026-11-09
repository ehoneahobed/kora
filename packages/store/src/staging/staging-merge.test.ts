import type { HLCTimestamp, Operation } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'
import { ensureUnappliedTable } from '../sync/sync-durability'
import type { Transaction } from '../types'
import { type StagingMergeHost, mergeStagingInto } from './staging-merge'

const schema = defineSchema({
	version: 1,
	collections: {
		notes: { fields: { title: t.string(), parentId: t.string().optional() } },
	},
	relations: {
		noteParent: {
			from: 'notes',
			to: 'notes',
			type: 'many-to-one',
			field: 'parentId',
			onDelete: 'set-null',
		},
	},
})

let counter = 0
function op(
	type: Operation['type'],
	recordId: string,
	data: Record<string, unknown> | null,
	options: { collection?: string; nodeId?: string; sequence?: number; at?: number } = {},
): Operation {
	counter += 1
	const nodeId = options.nodeId ?? 'remote'
	return {
		id: `m-${counter}-${recordId}`,
		nodeId,
		type,
		collection: options.collection ?? 'notes',
		recordId,
		data,
		previousData: type === 'update' ? {} : null,
		timestamp: { wallTime: 1_000_000 + (options.at ?? counter), logical: 0, nodeId },
		sequenceNumber: options.sequence ?? counter,
		causalDeps: [],
		schemaVersion: 1,
	}
}

interface Pair {
	live: Store
	liveAdapter: BetterSqlite3Adapter
	staging: Store
	stagingAdapter: BetterSqlite3Adapter
	host: StagingMergeHost & {
		transactions: number
		adopted: HLCTimestamp[]
		cancelAfter: number
		touched: string[]
		noted: Array<Map<string, number>>
		replayed: string[]
		stopAfterReplays: number
	}
	progress: string[]
}

const open: Store[] = []
afterEach(async () => {
	for (const store of open.splice(0)) await store.close()
})

async function pair(): Promise<Pair> {
	const liveAdapter = new BetterSqlite3Adapter(':memory:')
	const stagingAdapter = new BetterSqlite3Adapter(':memory:')
	const live = new Store({
		schema,
		adapter: liveAdapter,
		nodeId: 'live-node',
		materialization: 'fold',
	})
	const staging = new Store({
		schema,
		adapter: stagingAdapter,
		nodeId: 'staging-node',
		materialization: 'fold',
	})
	await live.open()
	await staging.open()
	open.push(live, staging)
	const progress: string[] = []
	const host = {
		schema,
		transactions: 0,
		adopted: [] as HLCTimestamp[],
		cancelAfter: Number.POSITIVE_INFINITY,
		touched: [] as string[],
		noted: [] as Array<Map<string, number>>,
		replayed: [] as string[],
		stopAfterReplays: Number.POSITIVE_INFINITY,
		transaction: async (fn: (tx: Transaction) => Promise<void>) => {
			// Counted when it is over: a transaction asks shouldContinue inside itself.
			await liveAdapter.transaction(fn)
			host.transactions += 1
		},
		localNodeIds: async () => new Set(['live-node']),
		touchCollection: (collection: string) => {
			host.touched.push(collection)
		},
		noteVersionVector: (entries: ReadonlyMap<string, number>) => {
			host.noted.push(new Map(entries))
		},
		receiveTimestamp: (timestamp: HLCTimestamp) => {
			host.adopted.push(timestamp)
		},
		invalidate: () => undefined,
		replay: async (operation: Operation) => {
			host.replayed.push(operation.id)
			await live.applyRemoteOperation(operation)
		},
		assertWritable: () => undefined,
		shouldContinue: () =>
			host.transactions < host.cancelAfter && host.replayed.length < host.stopAfterReplays,
	}
	return { live, liveAdapter, staging, stagingAdapter, host, progress }
}

async function merge(
	p: Pair,
	maxParamsPerStatement?: number,
): Promise<Awaited<ReturnType<typeof mergeStagingInto>>> {
	return mergeStagingInto(p.host, p.stagingAdapter, {
		...(maxParamsPerStatement !== undefined ? { maxParamsPerStatement } : {}),
		writeProgress: async (tx) => {
			p.progress.push('written')
			await tx.execute('INSERT OR REPLACE INTO _kora_meta (key, value) VALUES (?, ?)', ['wm', '7'])
		},
	})
}

describe('mergeStagingInto copies whole records verbatim', () => {
	test('rows, log, fold state and base arrive as staged; the watermark is written in the last transaction', async () => {
		const p = await pair()
		await p.staging.applyRemoteOperation(op('insert', 'n1', { title: 'one' }))
		await p.staging.applyRemoteOperation(op('update', 'n1', { title: 'uno' }))
		const result = await merge(p)
		expect(result.kind).toBe('merged')
		for (const table of ['notes', '_kora_ops_notes', '_kora_fold_state', '_kora_fold_base']) {
			expect(await p.liveAdapter.query(`SELECT * FROM ${table} ORDER BY 1`)).toEqual(
				await p.stagingAdapter.query(`SELECT * FROM ${table} ORDER BY 1`),
			)
		}
		expect(await p.liveAdapter.query("SELECT value FROM _kora_meta WHERE key = 'wm'")).toEqual([
			{ value: '7' },
		])
		expect(p.progress).toEqual(['written'])
	})

	test('fold snapshots, provisional effects and retraction markers of a staged record are copied', async () => {
		const p = await pair()
		await p.staging.applyRemoteOperation(op('insert', 'n1', { title: 'one' }))
		await p.stagingAdapter.execute(
			"INSERT INTO _kora_fold_snapshot (collection, record_id, state) VALUES ('notes', 'n1', 'snapshot-state')",
		)
		await p.stagingAdapter.execute(
			"INSERT INTO _kora_provisional_ops (id, collection, record_id, parent_id, operation) VALUES ('prov-1', 'notes', 'n1', 'n0', '{}')",
		)
		await p.stagingAdapter.execute(
			"INSERT INTO _kora_scope_retractions (collection, record_id, position) VALUES ('notes', 'n1', 3.5)",
		)
		expect((await merge(p)).kind).toBe('merged')
		expect(await p.liveAdapter.query('SELECT * FROM _kora_fold_snapshot')).toEqual([
			{ collection: 'notes', record_id: 'n1', state: 'snapshot-state' },
		])
		expect(
			await p.liveAdapter.query('SELECT id, record_id, parent_id FROM _kora_provisional_ops'),
		).toEqual([{ id: 'prov-1', record_id: 'n1', parent_id: 'n0' }])
		expect(await p.liveAdapter.query('SELECT * FROM _kora_scope_retractions')).toEqual([
			{ collection: 'notes', record_id: 'n1', position: 3.5 },
		])
	})

	test('operations received under a local node id and quarantine rows arrive with the progress', async () => {
		const p = await pair()
		await p.staging.applyRemoteOperation(op('insert', 'n1', { title: 'one' }))
		await ensureUnappliedTable(p.stagingAdapter)
		await ensureUnappliedTable(p.liveAdapter)
		await p.stagingAdapter.execute("INSERT INTO _kora_received_local_ops (id) VALUES ('echo-1')")
		await p.stagingAdapter.execute(
			"INSERT INTO _kora_unapplied_ops (op_id, collection, delivery_seq, position, code, message, quarantined_at, payload) VALUES ('q-1', 'ghosts', 4, 0, 'UNKNOWN_COLLECTION', 'no such collection', 1, '{}')",
		)
		const result = await merge(p)
		expect(result.kind === 'merged' && result.quarantined).toBe(1)
		expect(await p.liveAdapter.query('SELECT id FROM _kora_received_local_ops')).toEqual([
			{ id: 'echo-1' },
		])
		expect(await p.liveAdapter.query('SELECT op_id FROM _kora_unapplied_ops')).toEqual([
			{ op_id: 'q-1' },
		])
	})
})

describe('mergeStagingInto never copies over what the live database already knows', () => {
	test('a record the live database has history for is replayed, not copied (live history survives)', async () => {
		const p = await pair()
		await p.live.applyRemoteOperation(
			op('insert', 'n1', { title: 'live' }, { nodeId: 'other', at: 10 }),
		)
		await p.staging.applyRemoteOperation(op('insert', 'n1', { title: 'staged' }, { at: 20 }))
		const result = await merge(p)
		expect(result.kind === 'merged' && result.contestedRecords).toBe(1)
		expect(await p.liveAdapter.query('SELECT COUNT(*) AS n FROM _kora_ops_notes')).toEqual([
			{ n: 2 },
		])
		expect(await p.liveAdapter.query('SELECT title FROM notes WHERE id = ?', ['n1'])).toEqual([
			{ title: 'staged' },
		])
	})

	test("an operation staged under this database's own node id is replayed through the ordinary path", async () => {
		const p = await pair()
		await p.staging.applyRemoteOperation(
			op('insert', 'n1', { title: 'mine' }, { nodeId: 'live-node' }),
		)
		const result = await merge(p)
		expect(
			result.kind === 'merged' && [result.contestedRecords, result.replayedOperations],
		).toEqual([1, 1])
		expect(await p.liveAdapter.query('SELECT COUNT(*) AS n FROM _kora_ops_notes')).toEqual([
			{ n: 1 },
		])
	})

	test('a (node, sequence) the live log holds for another operation id makes the record contested', async () => {
		const p = await pair()
		await p.live.applyRemoteOperation(
			op('insert', 'x1', { title: 'x' }, { nodeId: 'dup', sequence: 5 }),
		)
		await p.staging.applyRemoteOperation(
			op('insert', 'n1', { title: 'n' }, { nodeId: 'dup', sequence: 5 }),
		)
		const result = await merge(p)
		expect(result.kind === 'merged' && result.contestedRecords).toBe(1)
	})

	test('a record retracted in the live database that the stream also delivers is unmergeable', async () => {
		const p = await pair()
		await p.live.applyRemoteOperation(op('insert', 'n1', { title: 'live' }, { nodeId: 'other' }))
		await p.liveAdapter.execute(
			"INSERT INTO _kora_scope_retractions (collection, record_id, position) VALUES ('notes', 'n1', 1)",
		)
		await p.staging.applyRemoteOperation(op('update', 'n1', { title: 'staged' }))
		const result = await merge(p)
		expect(result.kind).toBe('unmergeable')
	})

	test('a staged retraction on a record the live database also wrote is unmergeable', async () => {
		const p = await pair()
		await p.live.applyRemoteOperation(op('insert', 'n1', { title: 'live' }, { nodeId: 'other' }))
		await p.staging.applyRemoteOperation(op('update', 'n1', { title: 'staged' }))
		await p.stagingAdapter.execute(
			"INSERT INTO _kora_scope_retractions (collection, record_id, position) VALUES ('notes', 'n1', 1)",
		)
		expect((await merge(p)).kind).toBe('unmergeable')
	})
})

describe('mergeStagingInto refuses what it cannot reproduce faithfully', () => {
	test('a staged column the live table lacks', async () => {
		const p = await pair()
		await p.staging.applyRemoteOperation(op('insert', 'n1', { title: 'one' }))
		await p.stagingAdapter.execute('ALTER TABLE notes ADD COLUMN extra TEXT')
		const result = await merge(p)
		expect(result.kind).toBe('unmergeable')
	})

	test('a staged operation-log column the live log lacks', async () => {
		const p = await pair()
		await p.staging.applyRemoteOperation(op('insert', 'n1', { title: 'one' }))
		await p.stagingAdapter.execute('ALTER TABLE _kora_ops_notes ADD COLUMN extra TEXT')
		expect((await merge(p)).kind).toBe('unmergeable')
	})

	test('a sequence-conflict row the staged log repaired locally, before anything is copied', async () => {
		const p = await pair()
		await p.staging.applyRemoteOperation(op('insert', 'n1', { title: 'one' }))
		const columns = await p.stagingAdapter.query<{ name: string; notnull: number }>(
			'PRAGMA table_info(_kora_seq_conflicts)',
		)
		await p.stagingAdapter.execute(
			`INSERT INTO _kora_seq_conflicts (${columns.map((c) => c.name).join(', ')}) VALUES (${columns.map(() => "'x'").join(', ')})`,
		)
		expect((await merge(p)).kind).toBe('unmergeable')
		expect(p.host.transactions).toBe(0)
		const rows = await p.liveAdapter.query<{ n: number }>('SELECT COUNT(*) AS n FROM notes')
		expect(rows[0]?.n).toBe(0)
	})
})

describe('mergeStagingInto keeps legacy sequence conflicts', () => {
	/** A database that applied the same stream directly: what the merge has to reproduce. */
	async function direct(ops: readonly Operation[]): Promise<BetterSqlite3Adapter> {
		const adapter = new BetterSqlite3Adapter(':memory:')
		const store = new Store({ schema, adapter, nodeId: 'direct-node', materialization: 'fold' })
		await store.open()
		open.push(store)
		for (const operation of ops) await store.applyRemoteOperation(operation)
		return adapter
	}

	async function state(adapter: BetterSqlite3Adapter): Promise<Record<string, unknown>> {
		return {
			rows: await adapter.query('SELECT * FROM notes ORDER BY id'),
			log: await adapter.query('SELECT id FROM _kora_ops_notes ORDER BY id'),
			conflicts: await adapter.query(
				'SELECT id, collection, node_id, record_id, sequence_number, reason, reemitted_as FROM _kora_seq_conflicts ORDER BY id',
			),
			folds: await adapter.query(
				'SELECT collection, record_id, state FROM _kora_fold_state ORDER BY collection, record_id',
			),
		}
	}

	async function staged(p: Pair, ops: readonly Operation[]): Promise<void> {
		for (const operation of ops) await p.staging.applyRemoteOperation(operation)
	}

	function colliding(): Operation[] {
		return [
			op('insert', 'holder', { title: 'one' }, { sequence: 7 }),
			op('insert', 'only-in-conflicts', { title: 'two' }, { sequence: 7 }),
		]
	}

	test('reproduces what the direct path stores', async () => {
		const p = await pair()
		const ops = colliding()
		await staged(p, ops)
		const result = await merge(p)
		expect(result).toMatchObject({ kind: 'merged', sequenceConflicts: 1, records: 2 })
		expect(await state(p.liveAdapter)).toEqual(await state(await direct(ops)))
	})

	test('a record whose only history is a conflict row still folds it afterwards', async () => {
		const p = await pair()
		const [holder, conflict] = colliding()
		await staged(p, [holder as Operation, conflict as Operation])
		await merge(p)
		// Older than the insert: a fold that lost the conflict row would show this title.
		const older = {
			...op('update', 'only-in-conflicts', { title: 'older' }, { at: -500_000 }),
			sequenceNumber: 99,
		}
		await p.live.applyRemoteOperation(older)
		const rows = await p.liveAdapter.query<{ title: string }>(
			'SELECT title FROM notes WHERE id = ?',
			['only-in-conflicts'],
		)
		expect(rows[0]?.title).toBe('two')
	})

	test('a record the live database knows replays its conflict row', async () => {
		const p = await pair()
		const ops = colliding()
		await staged(p, ops)
		const written = op('update', 'only-in-conflicts', { title: 'here' }, { nodeId: 'elsewhere' })
		await p.live.applyRemoteOperation(written)
		const result = await merge(p)
		expect(result).toMatchObject({ kind: 'merged', sequenceConflicts: 0 })
		expect(p.host.replayed).toContain(ops[1]?.id)
		const rows = await p.liveAdapter.query<{ title: string }>(
			'SELECT title FROM notes WHERE id = ?',
			['only-in-conflicts'],
		)
		expect(rows[0]?.title).toBe('here')
	})

	test('a retried merge after a crash ends with the same state and no duplicates', async () => {
		const p = await pair()
		const ops: Operation[] = []
		for (let i = 0; i < 260; i++) {
			const sequence = i < 130 ? i + 1 : i - 129
			ops.push(op('insert', `n${String(i).padStart(3, '0')}`, { title: `t${i}` }, { sequence }))
		}
		await staged(p, ops)
		p.host.cancelAfter = 1
		expect(await merge(p)).toMatchObject({ kind: 'unmergeable', cancelled: true })
		p.host.cancelAfter = Number.POSITIVE_INFINITY
		expect((await merge(p)).kind).toBe('merged')
		const expected = (await state(await direct(ops))) as { rows: unknown[]; conflicts: unknown[] }
		const actual = (await state(p.liveAdapter)) as { rows: unknown[]; conflicts: unknown[] }
		expect(actual.rows).toEqual(expected.rows)
		expect(actual.conflicts).toHaveLength(130)
	})

	test('the local clock moves past a stamp only a conflict row carries', async () => {
		const p = await pair()
		const holder = op('insert', 'holder', { title: 'one' }, { sequence: 7, at: 1 })
		const conflict = op('insert', 'late', { title: 'two' }, { sequence: 7, at: 900_000 })
		await staged(p, [holder, conflict])
		await merge(p)
		expect(p.host.adopted.map((stamp) => stamp.wallTime)).toContain(1_900_000)
	})

	test.each([1, 2, 3, 4, 5])(
		'random legacy streams match the direct path (seed %i)',
		async (seed) => {
			let next = seed * 7919
			const random = (limit: number): number => {
				next = (next * 48271) % 2147483647
				return next % limit
			}
			const ops: Operation[] = []
			for (let i = 0; i < 60; i++) {
				const record = `r${random(12)}`
				const known = ops.some((item) => item.recordId === record)
				ops.push(
					op(known ? 'update' : 'insert', record, { title: `v${i}` }, { sequence: random(15) + 1 }),
				)
			}
			const p = await pair()
			await staged(p, ops)
			expect((await merge(p)).kind).toBe('merged')
			expect(await state(p.liveAdapter)).toEqual(await state(await direct(ops)))
		},
	)
})

describe('mergeStagingInto commits in bounded chunks', () => {
	test('a cancelled merge stops between chunks and leaves whole records and no progress', async () => {
		const p = await pair()
		for (let i = 0; i < 250; i++) {
			await p.staging.applyRemoteOperation(
				op('insert', `n${String(i).padStart(3, '0')}`, { title: `t${i}` }),
			)
		}
		p.host.cancelAfter = 1
		const result = await merge(p)
		expect(result.kind).toBe('unmergeable')
		expect(result).toMatchObject({ cancelled: true })
		expect(p.progress).toEqual([])
		const rows = await p.liveAdapter.query<{ n: number }>('SELECT COUNT(*) AS n FROM notes')
		const logs = await p.liveAdapter.query<{ n: number }>(
			'SELECT COUNT(*) AS n FROM _kora_ops_notes',
		)
		const folds = await p.liveAdapter.query<{ n: number }>(
			'SELECT COUNT(*) AS n FROM _kora_fold_state',
		)
		expect(rows[0]?.n).toBeGreaterThan(0)
		expect(rows[0]?.n).toBeLessThan(250)
		expect([logs[0]?.n, folds[0]?.n]).toEqual([rows[0]?.n, rows[0]?.n])
	})

	test('a merge cancelled at any check, inside a transaction or between them, leaves whole records and no progress', async () => {
		// Count the checks of an uninterrupted merge, then cancel at each one in turn.
		const total = await (async (): Promise<number> => {
			const p = await pair()
			for (let i = 0; i < 250; i++) {
				await p.staging.applyRemoteOperation(
					op('insert', `n${String(i).padStart(3, '0')}`, { title: `t${i}` }),
				)
			}
			let checks = 0
			const real = p.host.shouldContinue
			p.host.shouldContinue = () => {
				checks += 1
				return real()
			}
			expect((await merge(p)).kind).toBe('merged')
			return checks
		})()
		expect(total).toBeGreaterThan(4)
		for (let at = 1; at <= total; at++) {
			const p = await pair()
			for (let i = 0; i < 250; i++) {
				await p.staging.applyRemoteOperation(
					op('insert', `n${String(i).padStart(3, '0')}`, { title: `t${i}` }),
				)
			}
			let checks = 0
			p.host.shouldContinue = () => {
				checks += 1
				return checks < at
			}
			const result = await merge(p)
			expect(result, `cancelled at check ${at}`).toMatchObject({
				kind: 'unmergeable',
				cancelled: true,
			})
			// Progress is durable only for a merge that finished (the write itself may have run and
			// been rolled back with its transaction).
			expect(
				await p.liveAdapter.query("SELECT value FROM _kora_meta WHERE key = 'wm'"),
				`progress at check ${at}`,
			).toEqual([])
			const [rows, logs, folds] = await Promise.all([
				p.liveAdapter.query<{ n: number }>('SELECT COUNT(*) AS n FROM notes'),
				p.liveAdapter.query<{ n: number }>('SELECT COUNT(*) AS n FROM _kora_ops_notes'),
				p.liveAdapter.query<{ n: number }>('SELECT COUNT(*) AS n FROM _kora_fold_state'),
			])
			expect([logs[0]?.n, folds[0]?.n], `whole records at check ${at}`).toEqual([
				rows[0]?.n,
				rows[0]?.n,
			])
		}
	})

	test('a merge cancelled before its final transaction writes no progress', async () => {
		const p = await pair()
		await p.staging.applyRemoteOperation(op('insert', 'n1', { title: 'one' }))
		p.host.cancelAfter = 1
		const result = await merge(p)
		expect(result.kind).toBe('unmergeable')
		// A cancellation says so: the caller must not treat it as a stream that cannot be merged.
		expect(result).toMatchObject({ cancelled: true })
		expect(p.progress).toEqual([])
	})

	test('records with long histories are split by operation count, not only by record count', async () => {
		const p = await pair()
		for (let record = 0; record < 3; record++) {
			const id = `h${record}`
			await p.staging.applyRemoteOperation(op('insert', id, { title: 'v0' }))
			for (let version = 1; version <= 1800; version++) {
				await p.staging.applyRemoteOperation(op('update', id, { title: `v${version}` }))
			}
		}
		const result = await merge(p)
		// 3 records x 1801 operations, at most 4,000 operations a chunk: two records, then one,
		// plus the final transaction.
		expect(result.kind === 'merged' && result.chunks).toBe(3)
	}, 60_000)

	test('the local clock moves past a chunk before its rows are committed', async () => {
		const p = await pair()
		await p.staging.applyRemoteOperation(op('insert', 'n1', { title: 'one' }, { at: 9_999 }))
		let adoptedBeforeCommit = false
		const transaction = p.host.transaction
		p.host.transaction = async (fn) => {
			if (p.host.adopted.length > 0) adoptedBeforeCommit = true
			await transaction(fn)
		}
		await merge(p)
		expect(adoptedBeforeCommit).toBe(true)
		expect(p.host.adopted[0]?.wallTime).toBe(1_000_000 + 9_999)
	})

	test('a self-referencing record staged before its parent merges in one chunk (foreign keys are checked at commit)', async () => {
		const p = await pair()
		await p.staging.applyRemoteOperation(op('insert', 'a-parent', { title: 'p' }))
		await p.staging.applyRemoteOperation(
			op('insert', 'b-child', { title: 'c', parentId: 'a-parent' }),
		)
		await p.staging.applyRemoteOperation(
			op('insert', 'c-grandchild', { title: 'g', parentId: 'b-child' }),
		)
		expect((await merge(p)).kind).toBe('merged')
		expect(await p.liveAdapter.query('SELECT id FROM notes ORDER BY id')).toHaveLength(3)
	})
})

describe('mergeStagingInto reports what it did to the host', () => {
	test('the collection is touched, the version vector is noted in the chunk and again with the progress', async () => {
		const p = await pair()
		await p.staging.applyRemoteOperation(
			op('insert', 'n1', { title: 'one' }, { nodeId: 'remote', sequence: 4 }),
		)
		await merge(p)
		expect(p.host.touched).toContain('notes')
		// Once for the chunk's operations, once with the staged vector in the last transaction.
		expect(p.host.noted).toHaveLength(2)
		expect(p.host.noted[0]?.get('remote')).toBe(4)
	})

	test('the chunk size grows when a chunk is quick: 250 records take two data chunks, not three', async () => {
		const p = await pair()
		for (let i = 0; i < 250; i++) {
			await p.staging.applyRemoteOperation(
				op('insert', `n${String(i).padStart(3, '0')}`, { title: `t${i}` }),
			)
		}
		const now = vi.spyOn(Date, 'now').mockReturnValue(5_000_000)
		try {
			const result = await merge(p)
			// 100 first, then the rest in one chunk (a chunk that took 1 ms is scaled up), plus the last.
			expect(result.kind === 'merged' && result.chunks).toBe(3)
		} finally {
			now.mockRestore()
		}
	})

	test('a merge cancelled while replaying contested operations stops before the next one', async () => {
		const p = await pair()
		for (const id of ['a', 'b']) {
			await p.live.applyRemoteOperation(
				op('insert', id, { title: 'live' }, { nodeId: 'other', at: 10 }),
			)
			await p.staging.applyRemoteOperation(op('update', id, { title: 'staged' }, { at: 20 }))
		}
		p.host.stopAfterReplays = 1
		const result = await merge(p)
		expect(result.kind).toBe('unmergeable')
		expect(result).toMatchObject({ cancelled: true })
		expect(p.host.replayed).toHaveLength(1)
		expect(p.progress).toEqual([])
	})

	test('rows that reference each other in a cycle merge because foreign keys are checked at commit', async () => {
		const p = await pair()
		await p.stagingAdapter.execute('PRAGMA foreign_keys = OFF')
		await p.staging.applyRemoteOperation(op('insert', 'a', { title: 'a', parentId: 'b' }))
		await p.staging.applyRemoteOperation(op('insert', 'b', { title: 'b', parentId: 'a' }))
		expect((await merge(p)).kind).toBe('merged')
		expect(await p.liveAdapter.query('SELECT id FROM notes ORDER BY id')).toHaveLength(2)
	})

	test('a cycle whose rows are inserted by separate statements merges because the check is deferred to commit', async () => {
		const p = await pair()
		await p.stagingAdapter.execute('PRAGMA foreign_keys = OFF')
		await p.staging.applyRemoteOperation(op('insert', 'a', { title: 'a', parentId: 'b' }))
		await p.staging.applyRemoteOperation(op('insert', 'b', { title: 'b', parentId: 'a' }))
		// One bound variable per statement: every row is its own INSERT, so the first one
		// references a row that does not exist until a later statement of the same transaction.
		expect((await merge(p, 1)).kind).toBe('merged')
		expect(await p.liveAdapter.query('SELECT id, parentId FROM notes ORDER BY id')).toEqual([
			{ id: 'a', parentId: 'b' },
			{ id: 'b', parentId: 'a' },
		])
	})
})

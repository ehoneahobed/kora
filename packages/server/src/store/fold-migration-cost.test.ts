/**
 * Cost regression for the startup re-materialization and for steady-state richtext
 * writes (koradocs upgrade incident, beta.12 -> canary). A record with many richtext
 * edits must migrate with O(n) richtext merges, not O(n^2): per-operation scope
 * snapshots keep scalar fields only, so they must never materialize the richtext body.
 * A later richtext write must merge only what it adds, not the whole history.
 *
 * Deterministic: the guard is the number of Yjs merges (`mergeRichtext` and
 * `mergeRichtextUpdate` calls, counted through a module mock that fails fast once a
 * budget is exceeded), not wall-clock time; a generous time budget is only a
 * secondary guard. Postgres runs with KORA_PG_TEST_URL.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Operation, defineSchema, encodeBytesForOpData, t } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import * as Y from 'yjs'
import { MemoryServerStore } from './memory-server-store'
import { PostgresServerStore } from './postgres-server-store'
import { createSqliteServerStore } from './sqlite-server-store'

const budget = vi.hoisted(() => ({ merges: 0, limit: Number.POSITIVE_INFINITY }))

/** One Yjs merge (`mergeRichtext` or `mergeRichtextUpdate`): counted, failing fast past the budget. */
const spend = vi.hoisted(() => (): void => {
	budget.merges++
	if (budget.merges > budget.limit) {
		throw new Error(`richtext merge budget exceeded: more than ${budget.limit} Yjs merges`)
	}
})

vi.mock('@korajs/merge', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@korajs/merge')>()
	return {
		...actual,
		mergeRichtext: (...args: Parameters<typeof actual.mergeRichtext>) => {
			spend()
			return actual.mergeRichtext(...args)
		},
		mergeRichtextUpdate: (...args: Parameters<typeof actual.mergeRichtextUpdate>) => {
			spend()
			return actual.mergeRichtextUpdate(...args)
		},
	}
})

/** Richtext edits of the record (the incident document had 600 to 1,100). */
const EDITS = 600
/** Migration budget: the final projection merges each live update once (n - 1), plus slack. */
const MIGRATION_MERGES = 2 * EDITS + 20
/** One steady-state richtext write: its own update, a few times over at most. */
const WRITE_MERGES = 4

const schema = defineSchema({
	version: 1,
	collections: {
		docs: {
			fields: {
				title: t.string(),
				status: t.enum(['draft', 'review', 'published']).default('draft'),
				body: t.richtext(),
				tags: t.array(t.string()).default([]),
				views: t.number().merge('counter').default(0),
			},
		},
	},
})

let seq = 0
function op(input: Partial<Operation> & Pick<Operation, 'data'>): Operation {
	seq += 1
	return {
		id: `fold-cost-${seq}-${Math.random().toString(36).slice(2, 8)}`,
		nodeId: input.nodeId ?? 'device-a',
		type: 'update',
		collection: 'docs',
		recordId: 'doc-1',
		previousData: null,
		timestamp: { wallTime: 1_000_000 + seq, logical: 0, nodeId: input.nodeId ?? 'device-a' },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
		hashVersion: 2,
		...input,
	}
}

/**
 * A document's history as devices write it: an insert, then `EDITS` richtext saves
 * (each a full Yjs snapshot, as the richtext controller persists) from two devices
 * that sync now and then, interleaved with scalar, array and counter edits.
 */
function documentHistory(): { ops: Operation[]; device: Y.Doc } {
	const a = new Y.Doc()
	a.clientID = 101
	const b = new Y.Doc()
	b.clientID = 202
	let state = 7
	const next = (): number => {
		state = (state * 1103515245 + 12345) & 0x7fffffff
		return state / 0x7fffffff
	}
	const ops: Operation[] = [
		op({ type: 'insert', data: { title: 'Doc', status: 'draft', tags: [], views: 0 } }),
	]
	for (let i = 0; i < EDITS; i++) {
		const onA = next() < 0.7
		const doc = onA ? a : b
		const text = doc.getText('content')
		if (text.length > 20 && next() < 0.3) {
			const at = Math.floor(next() * (text.length - 5))
			text.delete(at, 1 + Math.floor(next() * 4))
		} else {
			text.insert(Math.floor(next() * (text.length + 1)), `w${i} `)
		}
		if (next() < 0.1) Y.applyUpdate(onA ? b : a, Y.encodeStateAsUpdate(doc))
		const nodeId = onA ? 'device-a' : 'device-b'
		ops.push(op({ nodeId, data: { body: encodeBytesForOpData(Y.encodeStateAsUpdate(doc)) } }))
		if (i % 6 === 0) ops.push(op({ nodeId, data: { title: `Doc v${i}` } }))
		if (i % 50 === 0) {
			ops.push(op({ nodeId, data: { status: i % 100 === 0 ? 'review' : 'draft' } }))
		}
		if (i % 40 === 0) ops.push(op({ nodeId, data: { tags: [`t${i % 3}`, 'x'] } }))
		if (i % 30 === 0) {
			ops.push(
				op({ nodeId, data: { views: i }, atomicOps: { views: { type: 'increment', value: 1 } } }),
			)
		}
	}
	return { ops, device: a }
}

/** One more richtext save of the device, after the history. */
function nextEdit(device: Y.Doc, label: string): Operation {
	const text = device.getText('content')
	text.insert(0, `${label} `)
	return op({ data: { body: encodeBytesForOpData(Y.encodeStateAsUpdate(device)) } })
}

interface CostStore {
	applyRemoteOperation(op: Operation): Promise<unknown>
	setSchema(value: typeof schema): Promise<void>
	findRecord(collection: string, id: string): Promise<Record<string, unknown> | null>
	getOperationScopeSnapshots(
		ids: string[],
	): Promise<
		Map<string, { pre: Record<string, unknown> | null; post: Record<string, unknown> | null }>
	>
	close(): Promise<void>
}

/** Merges `fn` performs; fails fast (the store call rejects) beyond `limit`. */
async function countMerges(limit: number, fn: () => Promise<unknown>): Promise<number> {
	budget.merges = 0
	budget.limit = limit
	try {
		await fn()
		return budget.merges
	} finally {
		budget.limit = Number.POSITIVE_INFINITY
	}
}

/**
 * The incident's shape on `open()`: a log written before fold states and scope
 * snapshots existed (the schema is installed only afterwards, like the first start
 * of a release that adds them), migrated by `setSchema`, then written to.
 */
async function migrationScenario(
	open: () => Promise<CostStore>,
	reopen?: () => Promise<CostStore>,
): Promise<void> {
	const { ops, device } = documentHistory()
	const store = await open()
	for (const operation of ops) await store.applyRemoteOperation(operation)

	const started = performance.now()
	const migrated = await countMerges(MIGRATION_MERGES, () => store.setSchema(schema))
	const elapsed = performance.now() - started
	expect(migrated).toBeLessThanOrEqual(MIGRATION_MERGES)
	// Secondary guard only (the count above is the real one): generous for slow CI.
	expect(elapsed).toBeLessThan(60_000)

	// The per-operation snapshots still say what the record was after each operation.
	const lastTitle = [...ops].reverse().find((o) => o.data && 'title' in o.data)
	const snapshots = await store.getOperationScopeSnapshots(ops.map((o) => o.id))
	expect(snapshots.size).toBe(ops.length)
	expect(snapshots.get(ops[ops.length - 1]?.id ?? '')?.post?.title).toBe(lastTitle?.data?.title)
	expect(snapshots.get(ops[0]?.id ?? '')?.pre).toBeNull()
	expect(Object.keys(snapshots.get(ops[0]?.id ?? '')?.post ?? {}).sort()).toEqual([
		'id',
		'status',
		'title',
		'views',
	])

	// Steady state: each richtext write merges what it adds, not the whole history.
	for (let i = 0; i < 3; i++) {
		const write = await countMerges(WRITE_MERGES, () =>
			store.applyRemoteOperation(nextEdit(device, `live${i}`)),
		)
		expect(write).toBeLessThanOrEqual(WRITE_MERGES)
	}
	const record = await store.findRecord('docs', 'doc-1')
	expect(record?.title).toBe(lastTitle?.data?.title)
	await store.close()

	if (!reopen) return
	// A restarted instance merges the history once (cold), then incrementally again.
	const restarted = await reopen()
	const first = await countMerges(EDITS + 20, () =>
		restarted.applyRemoteOperation(nextEdit(device, 'cold')),
	)
	expect(first).toBeLessThanOrEqual(EDITS + 20)
	const warm = await countMerges(WRITE_MERGES, () =>
		restarted.applyRemoteOperation(nextEdit(device, 'warm')),
	)
	expect(warm).toBeLessThanOrEqual(WRITE_MERGES)
	await restarted.close()
}

describe('richtext cost of the fold migration and of writes', () => {
	const dirs: string[] = []

	beforeEach(() => {
		budget.merges = 0
	})

	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
	})

	test('memory store', async () => {
		await migrationScenario(async () => new MemoryServerStore('server-memory'))
	}, 120_000)

	test('sqlite store', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'kora-test-foldcost-'))
		dirs.push(dir)
		const filename = join(dir, 'server.db')
		await migrationScenario(
			async () => createSqliteServerStore({ filename, nodeId: 'server-sqlite' }),
			async () => {
				const store = createSqliteServerStore({ filename, nodeId: 'server-sqlite' })
				await store.setSchema(schema)
				return store
			},
		)
	}, 120_000)
})

const PG_URL = process.env.KORA_PG_TEST_URL

describe.skipIf(!PG_URL)('postgres: richtext cost of the fold migration and of writes', () => {
	const clients: ReturnType<typeof postgres>[] = []
	const schemas: string[] = []

	afterAll(async () => {
		const admin = postgres(PG_URL ?? '', { max: 1 })
		for (const name of schemas) await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
		await admin.end()
		await Promise.all(clients.map((client) => client.end()))
	})

	test('postgres store', async () => {
		const name = `kora_foldcost_${process.pid}_${Math.random().toString(36).slice(2, 8)}`
		schemas.push(name)
		const admin = postgres(PG_URL ?? '', { max: 1 })
		await admin.unsafe(`CREATE SCHEMA ${name}`)
		await admin.end()
		const connect = (): PostgresServerStore => {
			const client = postgres(PG_URL ?? '', {
				max: 4,
				onnotice: () => {},
				connection: { search_path: name },
			})
			clients.push(client)
			return new PostgresServerStore(drizzle(client), 'server-pg')
		}
		await migrationScenario(
			async () => connect(),
			async () => {
				const store = connect()
				await store.setSchema(schema)
				return store
			},
		)
	}, 180_000)
})

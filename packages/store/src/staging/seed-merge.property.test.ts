import {
	type HLCTimestamp,
	type Operation,
	type SchemaDefinition,
	defineSchema,
	foldRecord,
	getFoldFieldVersions,
	materialize,
	t,
} from '@korajs/core'
import * as fc from 'fast-check'
import { afterEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { purgeSeedsInTx } from '../seed/seed-store'
import type { SeedInput } from '../seed/seed-store'
import { Store } from '../store/store'
import type { Transaction } from '../types'
import { type StagingMergeHost, mergeStagingInto } from './staging-merge'

/*
 * First-visit parity S4b, the store-level half of the convergence gate (design 10.1):
 *
 *   device A: seeded from the server's view at a random frontier, writes locally on the seeded
 *             record, then merges a staging replica that received the whole stream;
 *   device B: never read through, applied the same stream and A's writes directly.
 *
 * I2: no seed survives the merge. I3: before the merge, A's main database holds only seeds and
 * its own writes. I4: afterwards A and B hold identical rows and fold states.
 *
 * Not covered here (the browser and server halves of 10.1): crash mid-merge, a second tab,
 * grant changes, rich text. They need the harness of the packed-artifact matrix.
 */

const schema = defineSchema({
	version: 1,
	collections: {
		items: {
			fields: {
				title: t.string(),
				note: t.string().optional(),
				flag: t.boolean(),
				tags: t.array(t.string()),
				meta: t.object({ a: t.string(), b: t.string() }).optional(),
				score: t.number().merge('counter'),
				hi: t.number().merge('max'),
				lo: t.number().merge('min'),
				log: t.array(t.string()).merge('append-only'),
				stock: t.number(),
			},
			resolve: {
				stock: (local, remote, base) => (local as number) + ((remote as number) - (base as number)),
			},
		},
	},
}) as unknown as SchemaDefinition

type Values = Record<string, unknown>

// A seed is stamped at most five minutes ahead of the clock; stay well inside it, and ahead of
// the real clock so a local write made after the seed is concurrent with the unseen history.
const BASE = Date.now() + 120_000

const WORDS = ['a', 'b', 'c']
const arrayOf = fc.uniqueArray(fc.constantFrom(...WORDS), { maxLength: 3 })
const fieldValue: Record<string, fc.Arbitrary<unknown>> = {
	title: fc.constantFrom('x', 'y', 'z'),
	note: fc.constantFrom('p', 'q', null),
	flag: fc.boolean(),
	tags: arrayOf,
	meta: fc.record({ a: fc.constantFrom('1', '2'), b: fc.constantFrom('1', '2') }),
	score: fc.integer({ min: -5, max: 20 }),
	hi: fc.integer({ min: 0, max: 20 }),
	lo: fc.integer({ min: 0, max: 20 }),
	log: arrayOf,
	stock: fc.integer({ min: 0, max: 20 }),
}
const FIELD_NAMES = Object.keys(fieldValue)
const INSERT: Values = {
	title: 'x',
	note: null,
	flag: false,
	tags: [],
	meta: { a: '1', b: '1' },
	score: 0,
	hi: 0,
	lo: 10,
	log: [],
	stock: 5,
}

const changes: fc.Arbitrary<Values> = fc
	.subarray(FIELD_NAMES, { minLength: 1, maxLength: 4 })
	.chain((fields) =>
		fc.tuple(...fields.map((field) => fieldValue[field] as fc.Arbitrary<unknown>)).map((values) => {
			const out: Values = {}
			fields.forEach((field, i) => {
				out[field] = values[i]
			})
			return out
		}),
	)

const stamp = (wall: number, nodeId: string, logical = 0): HLCTimestamp => ({
	wallTime: BASE + wall,
	logical,
	nodeId,
})

let counter = 0
function operation(
	type: Operation['type'],
	recordId: string,
	timestamp: HLCTimestamp,
	data: Values | null,
	previousData: Values | null,
): Operation {
	counter += 1
	return {
		id: `${timestamp.nodeId}-${timestamp.wallTime}-${counter}`,
		nodeId: timestamp.nodeId,
		type,
		collection: 'items',
		recordId,
		data,
		previousData,
		timestamp,
		sequenceNumber: counter,
		causalDeps: [],
		schemaVersion: 1,
	}
}

/** One record's history in commit order: an insert, updates, and sometimes a final delete. */
function history(recordId: string): fc.Arbitrary<Operation[]> {
	return fc
		.tuple(
			fc.array(
				fc.record({
					changed: changes,
					wall: fc.integer({ min: 2, max: 40 }),
					node: fc.constantFrom('n1', 'n2', 'n3'),
				}),
				{ minLength: 0, maxLength: 6 },
			),
			fc.boolean(),
		)
		.map(([updates, deleted]) => {
			const ops = [operation('insert', recordId, stamp(1, 'n1'), INSERT, null)]
			let view: Values = { ...INSERT }
			const lastWall: Record<string, number> = { n1: 1 }
			let logical = 0
			for (const update of updates) {
				const previous: Values = {}
				for (const field of Object.keys(update.changed)) previous[field] = view[field]
				logical += 1
				const wall = Math.max(update.wall, lastWall[update.node] ?? 0)
				lastWall[update.node] = wall
				ops.push(
					operation(
						'update',
						recordId,
						stamp(wall, update.node, logical),
						update.changed,
						previous,
					),
				)
				view = { ...view, ...update.changed }
			}
			if (deleted) {
				logical += 1
				ops.push(operation('delete', recordId, stamp(45, 'n2', logical), null, null))
			}
			return ops
		})
}

/** The seed for a record as the server held it after `seen`, or null when it was not visible. */
function seedFor(recordId: string, seen: Operation[]): SeedInput | null {
	const state = foldRecord(seen, schema).state
	if (state === null) return null
	const values = materialize(state)
	const versions = getFoldFieldVersions(state)
	if (values === null || versions === null) return null
	return {
		collection: 'items',
		id: recordId,
		values,
		fieldVersions: versions.fields,
		created: versions.created,
		latest: versions.latest,
	}
}

const open: Store[] = []
afterEach(async () => {
	for (const store of open.splice(0)) await store.close()
})

async function newStore(nodeId: string): Promise<{ store: Store; adapter: BetterSqlite3Adapter }> {
	const adapter = new BetterSqlite3Adapter(':memory:')
	const store = new Store({ schema, adapter, nodeId, materialization: 'fold' })
	await store.open()
	open.push(store)
	return { store, adapter }
}

async function mergeInto(
	live: { store: Store; adapter: BetterSqlite3Adapter },
	staging: { adapter: BetterSqlite3Adapter },
): Promise<Awaited<ReturnType<typeof mergeStagingInto>>> {
	const host: StagingMergeHost = {
		schema,
		transaction: (fn: (tx: Transaction) => Promise<void>) => live.adapter.transaction(fn),
		localNodeIds: async () => new Set(['device']),
		touchCollection: () => undefined,
		noteVersionVector: () => undefined,
		receiveTimestamp: () => undefined,
		invalidate: () => undefined,
		replay: async (op) => {
			await live.store.applyRemoteOperation(op)
		},
		assertWritable: () => undefined,
		shouldContinue: () => true,
		purgeSeeds: async (tx, collection, ids) => {
			await purgeSeedsInTx(
				tx,
				collection !== null && ids !== null
					? ids.map((recordId) => ({ collection, recordId }))
					: undefined,
			)
		},
		settleSnapshots: (collection, ids) => live.store.settleSnapshots(collection, ids),
	}
	return mergeStagingInto(host, staging.adapter, { writeProgress: async () => undefined })
}

/**
 * Fold states compared as values. The order of keys inside the stored JSON follows the order
 * the fields were first folded, which differs between any two replicas that received the same
 * operations in a different order; it carries no meaning.
 */
function parsed(rows: unknown[]): unknown[] {
	return rows.map((row) => {
		const r = row as { state: string }
		return { ...r, state: JSON.parse(r.state) }
	})
}

/** An array compared as a multiset: the order of a seeded array may change once, at the merge. */
function multiset(value: unknown): unknown {
	return Array.isArray(value) ? [...value].sort() : value
}

const scenario = fc.record({
	seeded: history('seeded'),
	other: history('other'),
	cut: fc.nat({ max: 100 }),
	locals: fc.array(changes, { minLength: 0, maxLength: 3 }),
	order: fc.integer({ min: 0, max: 5 }),
	duplicate: fc.boolean(),
})

/** The commit order, with the two records' operations interleaved in a few fixed ways. */
function interleave(a: Operation[], b: Operation[], mode: number): Operation[] {
	if (mode === 0) return [...a, ...b]
	if (mode === 1) return [...b, ...a]
	const out: Operation[] = []
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const first = mode % 2 === 0 ? a : b
		const second = mode % 2 === 0 ? b : a
		if (first[i]) out.push(first[i] as Operation)
		if (second[i]) out.push(second[i] as Operation)
	}
	return out
}

describe('a seeded device that merges equals one that never read through (I2, I3, I4)', () => {
	test('for random histories, frontiers, local writes and delivery orders', async () => {
		await fc.assert(
			fc.asyncProperty(scenario, async (s) => {
				const stream = interleave(s.seeded, s.other, s.order)
				const cut = 1 + (s.cut % s.seeded.length)
				const seen = s.seeded.slice(0, cut)
				const seed = seedFor('seeded', seen)

				const staging = await newStore('staging')
				for (const op of s.duplicate ? [...stream, ...stream] : stream) {
					await staging.store.applyRemoteOperation(op)
				}

				const device = await newStore('device')
				if (seed !== null) {
					await device.store.seedRecords([seed], { frontier: cut, grantKey: 'g' })
					for (const changed of s.locals) {
						await device.store.collection('items').update('seeded', changed)
					}
				}
				// I3: the main database holds the seed and the device's own writes, nothing remote.
				const heldOps = await device.store.getOperationsForRecord('items', 'seeded')
				expect(heldOps.every((op) => op.nodeId === 'device')).toBe(true)
				expect(await device.store.getOperationsForRecord('items', 'other')).toEqual([])

				// What the device shows before the merge is the fold of what the server had and its own writes.

				const shown = await device.store.collection('items').findById('seeded')

				const folded = foldRecord([...seen, ...heldOps], schema).state
				const truth = seed === null || folded === null ? null : materialize(folded)

				if (truth === null) expect(shown).toBeNull()
				else
					for (const [field, value] of Object.entries(truth))
						expect(multiset(shown?.[field])).toEqual(multiset(value))

				const control = await newStore('control')
				for (const op of stream) await control.store.applyRemoteOperation(op)
				for (const op of heldOps) await control.store.applyRemoteOperation(op)

				expect((await mergeInto(device, staging)).kind).toBe('merged')

				// I2
				expect(await device.store.listSeeds()).toEqual([])
				const snapshots = 'SELECT * FROM _kora_fold_snapshot ORDER BY record_id'
				expect(parsed(await device.adapter.query(snapshots))).toEqual(
					parsed(await control.adapter.query(snapshots)),
				)
				// I4
				for (const id of ['seeded', 'other']) {
					expect(await device.store.collection('items').findById(id)).toEqual(
						await control.store.collection('items').findById(id),
					)
				}
				for (const table of ['_kora_fold_state', '_kora_fold_base']) {
					const query = `SELECT collection, record_id, state FROM ${table} ORDER BY record_id`
					expect(parsed(await device.adapter.query(query))).toEqual(
						parsed(await control.adapter.query(query)),
					)
				}
			}),
			{ numRuns: Number(process.env.KORA_PROPERTY_RUNS ?? 150), seed: 20261105 },
		)
	}, 120_000)
})

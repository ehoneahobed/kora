import { readFileSync } from 'node:fs'
import { fc } from '@fast-check/vitest'
import { defineSchema, op, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'
import type { CollectionRecord } from '../types'
import type { PendingEntry, PendingWrites } from './pending-writes'
import { divergentFields } from './predict'
import { GatedAdapter, quiesce } from './test-support'

/**
 * Instant-UI S6b: atomic operations (`op.increment`, `op.append`, ...), the `counter`, `max`,
 * `min` and `append-only` merge strategies and arrays are predicted, and the prediction equals
 * the committed fold.
 *
 * Real stores on real SQLite, real writes through the Collection API and `store.transaction`,
 * real remote operations from a second store, every commit held at a gate the test controls,
 * no timers (the one read budget is made too large to fire). Asserted per generated workload:
 *
 *  (1) NO DIVERGENCE: not one `store:overlay-diverged`, with remote writes landing between a
 *      write's prediction and its commit (the case where its base was stale), failed commits
 *      and rollbacks of chains of atomic writes.
 *  (2) SETTLE: after every commit has landed, each live query shows what a fresh SELECT
 *      returns and the registry is empty.
 *  (3) CONVERGENCE: the store and its peer hold the same records.
 *  (4) SOUNDNESS, when no remote write and no failure is involved: the record each write was
 *      predicted to produce is the record the database holds after the commits (modulo the
 *      two metadata times).
 *
 * Coverage guards fail the run if the interesting paths were not exercised.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		items: {
			fields: {
				title: t.string(),
				n: t.number().default(0),
				hits: t.number().merge('counter').default(0),
				best: t.number().merge('max').default(0),
				low: t.number().merge('min').default(100),
				tags: t.array(t.string()).default([]),
				log: t.array(t.string()).merge('append-only').default([]),
			},
		},
	},
})

const runs = Number(process.env.KORA_OVERLAY_ATOMIC_RUNS ?? 120)
const seed = process.env.KORA_OVERLAY_ATOMIC_SEED
	? Number(process.env.KORA_OVERLAY_ATOMIC_SEED)
	: undefined

// --- generators ---

const smallInt = fc.integer({ min: -3, max: 5 })
const word = fc.constantFrom('x', 'y', 'z')

/** One field write: a plain value or an atomic intent. */
type Intent =
	| { field: 'title'; value: string }
	| { field: 'n'; value: number }
	| { field: 'n'; atomic: 'increment' | 'max' | 'min'; value: number }
	| { field: 'hits'; value: number }
	| { field: 'hits'; atomic: 'increment'; value: number }
	| { field: 'best'; value: number }
	| { field: 'best'; atomic: 'max'; value: number }
	| { field: 'low'; value: number }
	| { field: 'low'; atomic: 'min'; value: number }
	| { field: 'tags' | 'log'; items: string[] }
	| { field: 'tags' | 'log'; atomic: 'append' | 'remove'; item: string }

const intentArb: fc.Arbitrary<Intent> = fc.oneof(
	{
		weight: 1,
		arbitrary: fc.constantFrom('t0', 't1').map((value): Intent => ({ field: 'title', value })),
	},
	{ weight: 1, arbitrary: smallInt.map((value): Intent => ({ field: 'n', value })) },
	{
		weight: 3,
		arbitrary: fc
			.tuple(fc.constantFrom('increment', 'max', 'min' as const), smallInt)
			.map(([atomic, value]): Intent => ({ field: 'n', atomic, value })),
	},
	{ weight: 1, arbitrary: smallInt.map((value): Intent => ({ field: 'hits', value })) },
	{
		weight: 4,
		arbitrary: smallInt.map((value): Intent => ({ field: 'hits', atomic: 'increment', value })),
	},
	{ weight: 1, arbitrary: smallInt.map((value): Intent => ({ field: 'best', value })) },
	{
		weight: 2,
		arbitrary: smallInt.map((value): Intent => ({ field: 'best', atomic: 'max', value })),
	},
	{ weight: 1, arbitrary: smallInt.map((value): Intent => ({ field: 'low', value })) },
	{
		weight: 2,
		arbitrary: smallInt.map((value): Intent => ({ field: 'low', atomic: 'min', value })),
	},
	{
		weight: 2,
		arbitrary: fc
			.tuple(fc.constantFrom('tags', 'log' as const), fc.array(word, { maxLength: 3 }))
			.map(([field, items]): Intent => ({ field, items })),
	},
	{
		weight: 4,
		arbitrary: fc
			.tuple(
				fc.constantFrom('tags', 'log' as const),
				fc.constantFrom('append', 'remove' as const),
				word,
			)
			.map(([field, atomic, item]): Intent => ({ field, atomic, item })),
	},
)

const intentsArb = fc.array(intentArb, { minLength: 1, maxLength: 3 })

type Step =
	| { kind: 'update'; target: number; intents: Intent[] }
	| { kind: 'group'; writes: Array<{ target: number; intents: Intent[] }> }
	| { kind: 'insert'; tags: string[]; hits: number }
	| { kind: 'delete'; target: number }
	| { kind: 'remote'; target: number; intents: Intent[] }
	| { kind: 'release' }
	| { kind: 'fail' }
	| { kind: 'turn' }

const stepArb: fc.Arbitrary<Step> = fc.oneof(
	{
		weight: 8,
		arbitrary: fc
			.tuple(fc.nat(20), intentsArb)
			.map(([target, intents]): Step => ({ kind: 'update', target, intents })),
	},
	{
		weight: 3,
		arbitrary: fc
			.array(fc.record({ target: fc.nat(20), intents: intentsArb }), { minLength: 1, maxLength: 3 })
			.map((writes): Step => ({ kind: 'group', writes })),
	},
	{
		weight: 1,
		arbitrary: fc
			.tuple(fc.array(word, { maxLength: 3 }), smallInt)
			.map(([tags, hits]): Step => ({ kind: 'insert', tags, hits })),
	},
	{ weight: 1, arbitrary: fc.nat(20).map((target): Step => ({ kind: 'delete', target })) },
	{
		weight: 4,
		arbitrary: fc
			.tuple(fc.nat(20), intentsArb)
			.map(([target, intents]): Step => ({ kind: 'remote', target, intents })),
	},
	{ weight: 4, arbitrary: fc.constant<Step>({ kind: 'release' }) },
	{ weight: 1, arbitrary: fc.constant<Step>({ kind: 'fail' }) },
	{ weight: 2, arbitrary: fc.constant<Step>({ kind: 'turn' }) },
)

/**
 * Half of the workloads are quiet (no remote write, no failure): there the last prediction of
 * every record must be the stored record (check 4). The rest add remote writes mid-flight,
 * and failures, where check 1 (no divergence) is the judge.
 */
const modeArb = fc.constantFrom('quiet', 'quiet', 'remote', 'faulty')

const workloadArb = fc.record({
	mode: modeArb,
	initial: fc.array(fc.record({ tags: fc.array(word, { maxLength: 3 }), hits: smallInt }), {
		minLength: 1,
		maxLength: 3,
	}),
	steps: fc.array(stepArb, { minLength: 1, maxLength: 14 }),
})

type Workload = {
	mode: 'quiet' | 'remote' | 'faulty'
	initial: Array<{ tags: string[]; hits: number }>
	steps: Step[]
}

/** The update input an intent list stands for (one value per field; the first one wins). */
function toUpdate(intents: readonly Intent[]): Record<string, unknown> {
	const data: Record<string, unknown> = {}
	for (const intent of intents) {
		if (intent.field in data) continue
		if ('atomic' in intent) {
			switch (intent.atomic) {
				case 'increment':
					data[intent.field] = op.increment(intent.value)
					break
				case 'max':
					data[intent.field] = op.max(intent.value)
					break
				case 'min':
					data[intent.field] = op.min(intent.value)
					break
				case 'append':
					data[intent.field] = op.append(intent.item)
					break
				case 'remove':
					data[intent.field] = op.remove(intent.item)
					break
			}
		} else if ('items' in intent) {
			data[intent.field] = intent.items
		} else {
			data[intent.field] = intent.value
		}
	}
	return data
}

// --- the harness ---

interface Counters {
	runs: number
	soundnessChecked: number
	withRemote: number
	withFails: number
	atomicPredicted: number
	arrayPredicted: number
	staleBases: number
	remoteArrays: number
	atomicFieldEntries: number
	groupsPredicted: number
	declined: Map<string, number>
}

const counters: Counters = {
	runs: 0,
	soundnessChecked: 0,
	withRemote: 0,
	withFails: 0,
	atomicPredicted: 0,
	arrayPredicted: 0,
	staleBases: 0,
	remoteArrays: 0,
	atomicFieldEntries: 0,
	groupsPredicted: 0,
	declined: new Map(),
}

const strip = (rows: readonly CollectionRecord[]) =>
	rows.map(({ createdAt: _c, updatedAt: _u, ...rest }) => rest)

async function runWorkload(workload: Workload): Promise<void> {
	const adapter = new GatedAdapter(':memory:')
	const peerAdapter = new BetterSqlite3Adapter(':memory:')
	const emitter = new SimpleEventEmitter()
	const peerEmitter = new SimpleEventEmitter()
	const store = new Store({
		schema,
		adapter,
		nodeId: 'node-a',
		emitter,
		instantUpdates: true,
		// Reads queue behind held commits and complete once the test releases them; the budget
		// is too large to ever fire, so no outcome depends on elapsed time.
		instantUpdatesInternals: { strict: false, baseReadTimeoutMs: 3_600_000 },
	})
	const peer = new Store({ schema, adapter: peerAdapter, nodeId: 'node-b', emitter: peerEmitter })
	let divergences: string[] = []
	emitter.on('store:overlay-diverged', (event) => {
		console.error(
			'DIVERGED',
			JSON.stringify(event),
			JSON.stringify(
				predicted.map((one) => [
					one.writeId,
					one.dependsOn,
					one.ancestors,
					one.groupId,
					one.patch,
					one.record.tags,
					!!one.foldState,
				]),
			),
			JSON.stringify(registry.list().map((e) => [e.writeId, e.state, e.dependsOn])),
		)
		divergences.push(`${event.collection}:${event.fields.join(',')}`)
	})
	await store.open()
	await peer.open()
	const controller = store.getOverlayController()
	if (!controller) throw new Error('the store was built without an overlay')
	const registry: PendingWrites = controller.registry

	const background: Array<Promise<unknown>> = []
	const absorb = (promise: Promise<unknown>) => {
		background.push(promise.catch(() => {}))
	}
	emitter.on('operation:created', (event) => absorb(peer.applyRemoteOperation(event.operation)))
	const remoteOps: Operation[] = []
	peerEmitter.on('operation:created', (event) => {
		remoteOps.push(event.operation)
		absorb(store.applyRemoteOperation(event.operation))
	})

	// What each write was predicted to produce, captured when it registered.
	const predicted: PendingEntry[] = []
	emitter.on('store:write-pending', (event) => {
		if (!event.predicted) return
		for (const entry of registry.list()) {
			if (!predicted.some((seen) => seen.writeId === entry.writeId)) predicted.push(entry)
		}
	})

	const items = store.collection('items')
	const peerItems = peer.collection('items')
	const knownIds: string[] = []
	for (const data of workload.initial) {
		knownIds.push((await items.insert({ title: 'seed', tags: data.tags, hits: data.hits })).id)
	}
	await quiesce()
	registry.settleCollection('items', registry.epoch)
	const seen: CollectionRecord[][] = []
	const everything = items.where({}).orderBy('id', 'asc')
	everything.subscribe((rows) => seen.push([...rows]))
	await quiesce()
	adapter.gating = true
	predicted.length = 0

	const pickId = (target: number): string | undefined =>
		knownIds.length === 0 ? undefined : knownIds[target % knownIds.length]
	const writes: Array<Promise<unknown>> = []
	const track = (promise: Promise<unknown>) => writes.push(promise.catch(() => {}))
	let failed = false
	let remote = false

	for (const step of workload.steps) {
		if (workload.mode === 'quiet' && (step.kind === 'remote' || step.kind === 'fail')) continue
		if (workload.mode === 'remote' && step.kind === 'fail') continue
		switch (step.kind) {
			case 'update': {
				const id = pickId(step.target)
				if (id) track(items.update(id, toUpdate(step.intents)))
				break
			}
			case 'group': {
				const targets = step.writes.map((one) => pickId(one.target))
				track(
					store.transaction(async (tx) => {
						const col = tx.collection('items')
						for (const [index, one] of step.writes.entries()) {
							const id = targets[index]
							if (id) await col.update(id, toUpdate(one.intents))
						}
					}),
				)
				break
			}
			case 'insert': {
				const inserted = items.insert({ title: 'new', tags: step.tags, hits: step.hits })
				track(inserted.then((row) => knownIds.push(row.id)))
				break
			}
			case 'delete': {
				const id = pickId(step.target)
				if (id) track(items.delete(id))
				break
			}
			case 'remote': {
				remote = true
				const id = pickId(step.target)
				if (id) {
					try {
						await peerItems.update(id, toUpdate(step.intents))
					} catch {
						// the peer does not hold the record (yet): a no-op step
					}
				}
				break
			}
			case 'release':
				adapter.gates.shift()?.release()
				break
			case 'fail':
				if (adapter.gates.length > 0) failed = true
				adapter.gates.shift()?.fail()
				break
			case 'turn':
				break
		}
		await quiesce()
	}

	const ATOMIC_FIELDS = ['hits', 'best', 'low', 'tags', 'log']
	for (const entry of predicted) {
		if (entry.kind !== 'update') continue
		const fields = Object.keys(entry.patch ?? {})
		// An entry that writes a counter / max / min / append-only / array field: the S6b paths.
		if (fields.some((field) => ATOMIC_FIELDS.includes(field))) counters.atomicFieldEntries += 1
		const arrays = fields.some((field) => field === 'tags' || field === 'log')
		if (arrays && entry.foldState) {
			counters.arrayPredicted += 1
			if (remote) counters.remoteArrays += 1
		}
	}
	counters.atomicPredicted += predicted.filter((entry) => entry.kind === 'update').length
	counters.groupsPredicted += new Set(
		predicted.flatMap((entry) => (entry.groupId ? [entry.groupId] : [])),
	).size

	// Let everything land.
	adapter.autoRelease = true
	for (const gate of adapter.gates.splice(0)) gate.release()
	// A failed gate can be a remote apply's; sync delivers it again, and it deduplicates by id.
	for (let i = 0; i < 8; i++) {
		await Promise.all([...writes, ...background])
		if (i === 0) for (const operation of remoteOps) absorb(store.applyRemoteOperation(operation))
		await quiesce()
	}

	// A transaction registers when its callback returns, which can be after the gates open.
	const clean = !failed && !remote && registry.misses.size === 0

	// (2) SETTLE
	const fresh = await everything.exec()
	expect(seen.at(-1), 'the live query shows what a fresh SELECT returns').toEqual(fresh)
	expect(registry.list(), 'entries left after settle').toEqual([])
	expect(registry.pendingCount).toBe(0)

	// (3) CONVERGENCE with the peer
	const peerRows = await peerItems.where({}).orderBy('id', 'asc').exec()
	expect(strip(peerRows), 'the peer holds the same records').toEqual(strip(fresh))

	// (1) NO DIVERGENCE
	expect(divergences, 'a prediction differed from the database').toEqual([])
	for (const [reason, count] of registry.misses) {
		counters.declined.set(reason, (counters.declined.get(reason) ?? 0) + count)
	}

	// (4) SOUNDNESS: the last prediction of each record is the stored record.
	if (clean) {
		counters.soundnessChecked += 1
		const lastOfRecord = new Map<string, PendingEntry>()
		for (const entry of predicted) lastOfRecord.set(entry.recordId, entry)
		for (const [id, entry] of lastOfRecord) {
			const stored = fresh.find((row) => row.id === id)
			if (entry.kind === 'delete') {
				expect(stored, `record ${id} was predicted deleted`).toBeUndefined()
			} else {
				expect(stored, `record ${id} was predicted to exist`).toBeDefined()
				if (stored) expect(divergentFields(entry.record, stored)).toEqual([])
			}
		}
	}
	counters.runs += 1
	if (remote) counters.withRemote += 1
	if (failed) counters.withFails += 1
	divergences = []
	await store.close()
	await peer.close()
}

describe('atomic operations, merge strategies and arrays are predicted (S6b)', () => {
	test(`prediction equals the committed fold over ${runs} generated workloads`, async () => {
		const before = { ...counters, declined: new Map(counters.declined) }
		await fc.assert(
			fc.asyncProperty(workloadArb, (workload) => runWorkload(workload)),
			{ numRuns: runs, ...(seed !== undefined ? { seed } : {}) },
		)
		const ran = counters.runs - before.runs
		// Guard against a vacuous pass.
		expect(ran).toBeGreaterThanOrEqual(Math.min(runs, 20))
		if (process.env.KORA_OVERLAY_ATOMIC_STATS)
			console.error('STATS', JSON.stringify({ ...counters, declined: [...counters.declined] }))
		expect(counters.atomicFieldEntries - before.atomicFieldEntries).toBeGreaterThan(ran)
		expect(counters.arrayPredicted - before.arrayPredicted).toBeGreaterThan(ran / 3)
		expect(counters.remoteArrays - before.remoteArrays).toBeGreaterThan(ran / 20)
		expect(counters.groupsPredicted - before.groupsPredicted).toBeGreaterThan(0)
		expect(counters.withRemote - before.withRemote).toBeGreaterThan(0)
		expect(counters.withFails - before.withFails).toBeGreaterThan(0)
		expect(counters.soundnessChecked - before.soundnessChecked).toBeGreaterThan(ran / 4)
	}, 600_000)
})

// Replay one counterexample fast-check printed: KORA_OVERLAY_ATOMIC_REPRO=<file holding the printed counterexample>.
if (process.env.KORA_OVERLAY_ATOMIC_REPRO) {
	test('replay of KORA_OVERLAY_ATOMIC_REPRO', async () => {
		const [workload] = JSON.parse(readFileSync(process.env.KORA_OVERLAY_ATOMIC_REPRO ?? '', 'utf8'))
		await runWorkload(workload)
	})
}

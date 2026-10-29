import { fc } from '@fast-check/vitest'
import { type Operation, defineSchema, t } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { afterEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from './store'

/**
 * C3b: a delivery batch applied from what it read up front (`RemoteBatchPrefetch`, the
 * batch-wide write buffer) ends in exactly the state, events and results of applying the
 * same operations one by one, whatever the operations are: same-record sequences, duplicates,
 * deletes, updates before their inserts, taken sequence numbers, operations that fail,
 * retractions between operations, and records that already hold history.
 */

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				completed: t.boolean().default(false),
				tags: t.array(t.string()).default([]),
			},
		},
		notes: { fields: { body: t.string(), n: t.number().default(0) } },
	},
})

const RECORDS = ['r1', 'r2', 'r3', 'r4']
const NODES = ['n1', 'n2', 'n3']
const TIMING_FIELDS = new Set(['duration'])

type Step =
	| { kind: 'op'; op: Operation }
	| { kind: 'retract'; collection: string; recordId: string }

/** One generated delivery: a stream of steps and where it is cut into batches. */
interface Scenario {
	steps: Step[]
	/** Steps applied one by one on every device first (history the batch must read). */
	prefix: number
	/** Sizes of the batches the rest is cut into. */
	cuts: number[]
}

const opSpecArb = fc.record({
	collection: fc.constantFrom('todos', 'todos', 'notes'),
	record: fc.constantFrom(...RECORDS),
	type: fc.constantFrom('insert', 'update', 'update', 'delete'),
	node: fc.constantFrom(...NODES),
	wall: fc.integer({ min: 1, max: 40 }),
	logical: fc.integer({ min: 0, max: 2 }),
	field: fc.integer({ min: 0, max: 2 }),
	text: fc.constantFrom('a', 'b', 'c', 'd'),
	tags: fc.array(fc.constantFrom('x', 'y', 'z'), { maxLength: 3 }),
	deps: fc.integer({ min: 0, max: 3 }),
	/** 0: ordinary, 1: delivered twice, 2: reuses an earlier sequence number, 3: far-future clock. */
	oddity: fc.constantFrom(0, 0, 0, 0, 0, 1, 1, 2, 3),
	retractAfter: fc.boolean(),
})

const scenarioArb: fc.Arbitrary<Scenario> = fc
	.record({
		specs: fc.array(opSpecArb, { minLength: 1, maxLength: 24 }),
		order: fc.array(fc.nat(), { minLength: 24, maxLength: 24 }),
		prefix: fc.nat({ max: 8 }),
		cuts: fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 1, maxLength: 12 }),
	})
	.map(({ specs, order, prefix, cuts }) => {
		const seqs = new Map<string, number>()
		const made: Operation[] = []
		const retract: boolean[] = []
		for (const [index, spec] of specs.entries()) {
			let sequenceNumber = (seqs.get(spec.node) ?? 0) + 1
			if (spec.oddity === 2 && made.length > 0) {
				// The sequence number of an earlier operation of the node (a conflicting one).
				const earlier = made.find((op) => op.nodeId === spec.node)
				if (earlier) sequenceNumber = earlier.sequenceNumber
			} else {
				seqs.set(spec.node, sequenceNumber)
			}
			const isTodo = spec.collection === 'todos'
			const data: Record<string, unknown> | null =
				spec.type === 'delete'
					? null
					: spec.type === 'insert'
						? isTodo
							? { title: spec.text, completed: false, tags: spec.tags }
							: { body: spec.text, n: spec.field }
						: isTodo
							? spec.field === 0
								? { title: spec.text }
								: spec.field === 1
									? { completed: spec.logical === 1 }
									: { tags: spec.tags }
							: spec.field === 0
								? { body: spec.text }
								: { n: spec.wall }
			made.push({
				id: `op-${index}-${spec.node}-${sequenceNumber}`,
				nodeId: spec.node,
				type: spec.type,
				collection: spec.collection,
				recordId: spec.record,
				data,
				previousData: spec.type === 'update' ? {} : null,
				timestamp: {
					wallTime: spec.oddity === 3 ? Date.now() + 3_600_000 : 1_000 + spec.wall,
					logical: spec.logical,
					nodeId: spec.node,
				},
				sequenceNumber,
				causalDeps: made.slice(0, spec.deps).map((op) => op.id),
				schemaVersion: 1,
			})
			retract.push(spec.retractAfter && spec.oddity === 0 && index % 3 === 0)
			if (spec.oddity === 1) {
				made.push(made[made.length - 1] as Operation)
				retract.push(false)
			}
		}
		// Delivered out of order: a stable shuffle by the generated keys.
		const indexes = made.map((_, index) => index)
		indexes.sort(
			(a, b) => (order[a % order.length] as number) - (order[b % order.length] as number) || a - b,
		)
		const steps: Step[] = []
		for (const index of indexes) {
			const op = made[index] as Operation
			steps.push({ kind: 'op', op })
			if (retract[index])
				steps.push({ kind: 'retract', collection: op.collection, recordId: op.recordId })
		}
		return { steps, prefix: Math.min(prefix, steps.length), cuts }
	})

interface Device {
	store: Store
	adapter: BetterSqlite3Adapter
	events: string[]
	results: string[]
}

const devices: Device[] = []
afterEach(async () => {
	for (const device of devices.splice(0)) await device.store.close()
})

async function newDevice(): Promise<Device> {
	const adapter = new BetterSqlite3Adapter(':memory:')
	const emitter = new SimpleEventEmitter()
	const store = new Store({ schema, adapter, nodeId: 'device', emitter })
	await store.open()
	const events: string[] = []
	for (const type of [
		'operation:applied',
		'merge:started',
		'merge:conflict',
		'merge:completed',
	] as const) {
		emitter.on(type, (event) =>
			events.push(
				JSON.stringify(event, (key, value) => (TIMING_FIELDS.has(key) ? undefined : value)),
			),
		)
	}
	const device: Device = { store, adapter, events, results: [] }
	devices.push(device)
	return device
}

/** Applies a step on its own, as the per-operation path does (a failing one is reported and skipped). */
async function applyOne(device: Device, step: Step, position: number): Promise<void> {
	if (step.kind === 'retract') {
		await device.store.applyScopeRetraction(step.collection, step.recordId, position + 0.5)
		device.results.push(`retract:${step.recordId}`)
		return
	}
	try {
		device.results.push(
			`${step.op.id}:${await device.store.applyRemoteOperation(step.op, { deliveryPosition: position })}`,
		)
	} catch (error) {
		device.results.push(`${step.op.id}:threw:${(error as Error).name}`)
	}
}

async function applyChunk(
	device: Device,
	steps: Step[],
	firstPosition: number,
	prefetch: boolean,
): Promise<void> {
	const outcome = await device.store.applyRemoteBatch(async (batch) => {
		if (prefetch) {
			await batch.prefetch(steps.flatMap((step) => (step.kind === 'op' ? [step.op] : [])))
		}
		for (const [offset, step] of steps.entries()) {
			const position = firstPosition + offset
			if (step.kind === 'retract') {
				await batch.applyScopeRetraction(step.collection, step.recordId, position + 0.5)
				device.results.push(`retract:${step.recordId}`)
				continue
			}
			try {
				device.results.push(
					`${step.op.id}:${await batch.applyRemoteOperation(step.op, { deliveryPosition: position })}`,
				)
			} catch (error) {
				device.results.push(`${step.op.id}:threw:${(error as Error).name}`)
			}
		}
	})
	expect(outcome).not.toBeNull()
}

async function snapshot(device: Device): Promise<unknown> {
	const all = async (sql: string): Promise<unknown[]> => device.adapter.query(sql)
	return {
		todos: await all('SELECT * FROM todos ORDER BY id'),
		notes: await all('SELECT * FROM notes ORDER BY id'),
		foldStates: await all('SELECT * FROM _kora_fold_state ORDER BY collection, record_id'),
		todoLog: await all('SELECT * FROM _kora_ops_todos ORDER BY id'),
		noteLog: await all('SELECT * FROM _kora_ops_notes ORDER BY id'),
		conflicts: await all(
			'SELECT id, collection, reemitted_as FROM _kora_seq_conflicts ORDER BY id',
		),
		retractions: await all('SELECT * FROM _kora_scope_retractions ORDER BY collection, record_id'),
		provisional: await all('SELECT * FROM _kora_provisional_ops ORDER BY id'),
		versionVector: await all('SELECT * FROM _kora_version_vector ORDER BY node_id'),
		memoryVersionVector: [...device.store.getVersionVector()].sort((a, b) =>
			a[0].localeCompare(b[0]),
		),
		events: device.events,
		results: device.results,
	}
}

describe('a prefetched, buffered delivery batch equals the per-operation apply', () => {
	test('generated operation sets, in any order, with duplicates, deletes, conflicts and retractions', async () => {
		await fc.assert(
			fc.asyncProperty(scenarioArb, async (scenario) => {
				const reference = await newDevice()
				const prefetched = await newDevice()
				const buffered = await newDevice()
				const { steps, prefix, cuts } = scenario
				for (let index = 0; index < prefix; index++) {
					for (const device of [reference, prefetched, buffered]) {
						await applyOne(device, steps[index] as Step, index + 1)
					}
				}
				let index = prefix
				for (let cut = 0; index < steps.length; cut++) {
					const size = cuts[cut % cuts.length] as number
					const chunk = steps.slice(index, index + size)
					for (const [offset, step] of chunk.entries()) {
						await applyOne(reference, step, index + offset + 1)
					}
					await applyChunk(prefetched, chunk, index + 1, true)
					await applyChunk(buffered, chunk, index + 1, false)
					index += size
				}
				const expected = await snapshot(reference)
				expect(await snapshot(prefetched)).toEqual(expected)
				expect(await snapshot(buffered)).toEqual(expected)
				for (const device of [reference, prefetched, buffered]) {
					await device.store.close()
				}
				devices.length = 0
			}),
			{ numRuns: 120 },
		)
	}, 120_000)

	test('a record the batch inserts and then updates sees its own earlier writes', async () => {
		const reference = await newDevice()
		const batched = await newDevice()
		const base = {
			nodeId: 'n1',
			collection: 'todos',
			recordId: 'r1',
			causalDeps: [],
			schemaVersion: 1,
		}
		const ops: Operation[] = [
			{
				...base,
				id: 'a',
				type: 'insert',
				data: { title: 'one', completed: false, tags: [] },
				previousData: null,
				timestamp: { wallTime: 1_001, logical: 0, nodeId: 'n1' },
				sequenceNumber: 1,
			},
			{
				...base,
				id: 'b',
				type: 'update',
				data: { title: 'two' },
				previousData: { title: 'one' },
				timestamp: { wallTime: 1_002, logical: 0, nodeId: 'n1' },
				sequenceNumber: 2,
			},
			{
				...base,
				id: 'c',
				type: 'delete',
				data: null,
				previousData: null,
				timestamp: { wallTime: 1_003, logical: 0, nodeId: 'n1' },
				sequenceNumber: 3,
			},
		]
		for (const [index, op] of ops.entries()) {
			await applyOne(reference, { kind: 'op', op }, index + 1)
		}
		await applyChunk(
			batched,
			ops.map((op) => ({ kind: 'op' as const, op })),
			1,
			true,
		)
		expect(await snapshot(batched)).toEqual(await snapshot(reference))
	})
})

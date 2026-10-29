import { fc } from '@fast-check/vitest'
import { type Operation, bytesToBase64, defineSchema, t } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { afterEach, describe, expect, test } from 'vitest'
import * as Y from 'yjs'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { ensureUnappliedTable, saveUnappliedOperations } from '../sync/sync-durability'
import type { Transaction } from '../types'
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
				score: t.number().merge('counter').default(0),
				hi: t.number().merge('max').default(0),
				lo: t.number().merge('min').default(0),
				log: t.array(t.string()).merge('append-only').default([]),
				stock: t.number().default(0),
				body: t.richtext().optional(),
			},
			resolve: {
				stock: (local, remote, base) => Number(local) + Number(remote) - Number(base),
			},
			constraints: [{ type: 'unique', fields: ['title'], onConflict: 'first-write-wins' }],
		},
		notes: { fields: { body: t.string(), n: t.number().default(0) } },
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
})

const RECORDS = ['r1', 'r2', 'r3', 'r4']
const NODES = ['n1', 'n2', 'n3']
const TIMING_FIELDS = new Set(['duration'])
/** A title no statement may carry: the poisoned adapter fails the operation-log insert. */
const POISON = 'BOOM'

type Step =
	| { kind: 'op'; op: Operation }
	| { kind: 'retract'; collection: string; recordId: string }
	| { kind: 'cascade'; parent: Operation; recordId: string }

/** One generated delivery: a stream of steps and where it is cut into batches. */
interface Scenario {
	steps: Step[]
	/** Steps applied one by one on every device first (history the batch must read). */
	prefix: number
	/** Sizes of the batches the rest is cut into. */
	cuts: number[]
}

function richtextValue(text: string, client: number): { $koraBytes: string } {
	const doc = new Y.Doc()
	doc.clientID = client
	doc.getText('content').insert(0, text)
	return { $koraBytes: bytesToBase64(Y.encodeStateAsUpdate(doc)) }
}

const opSpecArb = fc.record({
	collection: fc.constantFrom('todos', 'todos', 'todos', 'notes', 'projects', 'tasks'),
	record: fc.constantFrom(...RECORDS),
	type: fc.constantFrom('insert', 'update', 'update', 'delete'),
	node: fc.constantFrom(...NODES),
	wall: fc.integer({ min: 1, max: 40 }),
	logical: fc.integer({ min: 0, max: 2 }),
	field: fc.integer({ min: 0, max: 8 }),
	text: fc.constantFrom('a', 'b', 'c', 'd'),
	tags: fc.array(fc.constantFrom('x', 'y', 'z'), { maxLength: 3 }),
	amount: fc.integer({ min: -3, max: 5 }),
	atomic: fc.boolean(),
	versions: fc.boolean(),
	deps: fc.integer({ min: 0, max: 3 }),
	/**
	 * 0: ordinary, 1: delivered twice, 2 and 3: reuse a sequence number of an earlier
	 * operation of the node (on another record when there is one), 4: far-future clock,
	 * 5: fails when its log row is written.
	 */
	oddity: fc.constantFrom(0, 0, 0, 0, 1, 1, 2, 2, 2, 3, 4, 5),
	retractAfter: fc.boolean(),
	cascade: fc.boolean(),
})

function dataFor(spec: {
	collection: string
	type: string
	field: number
	text: string
	tags: string[]
	amount: number
	wall: number
	node: string
	logical: number
	oddity: number
}): Record<string, unknown> | null {
	if (spec.type === 'delete') return null
	const title = spec.oddity === 5 ? POISON : spec.text
	const insert = spec.type === 'insert'
	switch (spec.collection) {
		case 'todos':
			if (insert) {
				return { title, completed: false, tags: spec.tags, score: spec.amount, hi: spec.wall }
			}
			switch (spec.field % 9) {
				case 0:
					return { title }
				case 1:
					return { completed: spec.logical === 1 }
				case 2:
					return { tags: spec.tags }
				case 3:
					return { score: spec.amount }
				case 4:
					return { hi: spec.wall }
				case 5:
					return { lo: spec.amount }
				case 6:
					return { stock: spec.amount }
				case 7:
					return { body: richtextValue(spec.text, NODES.indexOf(spec.node) + 1) }
				default:
					return { log: spec.tags }
			}
		case 'notes':
			if (insert) return { body: title, n: spec.field }
			return spec.field % 2 === 0 ? { body: title } : { n: spec.wall }
		case 'projects':
			return { name: title }
		default:
			return insert ? { title, projectId: 'r1' } : { title }
	}
}

const scenarioArb: fc.Arbitrary<Scenario> = fc
	.record({
		specs: fc.array(opSpecArb, { minLength: 1, maxLength: 28 }),
		order: fc.array(fc.nat(), { minLength: 28, maxLength: 28 }),
		prefix: fc.nat({ max: 8 }),
		cuts: fc.array(fc.integer({ min: 1, max: 9 }), { minLength: 1, maxLength: 12 }),
	})
	.map(({ specs, order, prefix, cuts }) => {
		const seqs = new Map<string, number>()
		const made: Operation[] = []
		const after: Array<'retract' | 'cascade' | null> = []
		for (const [index, spec] of specs.entries()) {
			let sequenceNumber = (seqs.get(spec.node) ?? 0) + 1
			const earlierOfNode = made.filter((op) => op.nodeId === spec.node)
			if ((spec.oddity === 2 || spec.oddity === 3) && earlierOfNode.length > 0) {
				// The sequence number of an earlier operation of the node: a conflicting one, on
				// another record when there is one (the stale-holder case of a record that takes
				// the careful path while this one would not).
				const other = earlierOfNode.find((op) => op.recordId !== spec.record)
				sequenceNumber = (other ?? (earlierOfNode[0] as Operation)).sequenceNumber
			} else {
				seqs.set(spec.node, sequenceNumber)
			}
			const data = dataFor(spec)
			const atomic =
				spec.atomic && spec.collection === 'todos' && spec.type === 'update' && spec.field % 9 === 3
			const timestamp = {
				wallTime: spec.oddity === 4 ? Date.now() + 3_600_000 : 1_000 + spec.wall,
				logical: spec.logical,
				nodeId: spec.node,
			}
			const op: Operation = {
				id: `op-${index}-${spec.node}-${sequenceNumber}`,
				nodeId: spec.node,
				type: spec.type,
				collection: spec.collection,
				recordId: spec.record,
				data,
				previousData: spec.type === 'update' ? {} : null,
				timestamp,
				sequenceNumber,
				causalDeps: made.slice(0, spec.deps).map((earlier) => earlier.id),
				schemaVersion: 1,
			}
			if (atomic) op.atomicOps = { score: { type: 'increment', value: spec.amount } }
			if (spec.versions && spec.type === 'insert' && data !== null) {
				op.fieldVersions = Object.fromEntries(
					Object.keys(data).map((field) => [
						field,
						{ ...timestamp, logical: timestamp.logical + 1 },
					]),
				)
			}
			made.push(op)
			after.push(
				spec.cascade && spec.type === 'delete' && spec.collection === 'projects'
					? 'cascade'
					: spec.retractAfter && spec.oddity === 0 && index % 3 === 0
						? 'retract'
						: null,
			)
			if (spec.oddity === 1) {
				made.push(made[made.length - 1] as Operation)
				after.push(null)
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
			const follow = after[index]
			if (follow === 'retract') {
				steps.push({ kind: 'retract', collection: op.collection, recordId: op.recordId })
			} else if (follow === 'cascade') {
				steps.push({ kind: 'cascade', parent: op, recordId: 'r1' })
			}
		}
		return { steps, prefix: Math.min(prefix, steps.length), cuts }
	})

/** Fails the write of an operation-log row whose data carries the poison title. */
class PoisonedAdapter extends BetterSqlite3Adapter {
	override async transaction(fn: (tx: Transaction) => Promise<void>): Promise<void> {
		return super.transaction((tx) => fn(poisoned(tx)))
	}
}

function poisoned(tx: Transaction): Transaction {
	const check = (sql: string, params?: unknown[]): void => {
		if (
			sql.startsWith('INSERT INTO "_kora_ops_') &&
			params?.some((param) => typeof param === 'string' && param.includes(POISON))
		) {
			throw new Error('poisoned statement')
		}
	}
	return {
		execute: async (sql, params) => {
			check(sql, params)
			await tx.execute(sql, params)
		},
		query: (sql, params) => tx.query(sql, params),
		executeBatch: async (statements) => {
			for (const statement of statements) {
				check(statement.sql, statement.params)
				await tx.execute(statement.sql, statement.params)
			}
		},
	}
}

interface Device {
	store: Store
	adapter: BetterSqlite3Adapter
	events: string[]
	results: string[]
	audits: Array<Promise<void>>
	/** Operations whose step failed, as the engine would quarantine them. */
	failed: Operation[]
}

const devices: Device[] = []
afterEach(async () => {
	for (const device of devices.splice(0)) await device.store.close()
})

async function newDevice(): Promise<Device> {
	const adapter = new PoisonedAdapter(':memory:')
	const emitter = new SimpleEventEmitter()
	const store = new Store({ schema, adapter, nodeId: 'device', emitter })
	await store.open()
	await ensureUnappliedTable(adapter)
	const events: string[] = []
	const audits: Array<Promise<void>> = []
	for (const type of [
		'operation:applied',
		'merge:started',
		'merge:conflict',
		'merge:completed',
	] as const) {
		emitter.on(type, (event) => {
			events.push(
				JSON.stringify(event, (key, value) => (TIMING_FIELDS.has(key) ? undefined : value)),
			)
			// What the audit bridge does with a conflict: a durable trace, id by arrival order.
			if (event.type === 'merge:conflict') {
				audits.push(
					store.appendAuditTrace({
						id: `audit-${audits.length}`,
						recordedAt: 0,
						eventType: 'merge:conflict',
						trace: event.trace,
					}),
				)
			}
		})
	}
	const device: Device = { store, adapter, events, results: [], audits, failed: [] }
	devices.push(device)
	return device
}

function quarantineEntry(op: Operation, position: number) {
	return {
		operation: op,
		deliverySequence: position,
		position,
		code: 'APPLY_FAILED',
		message: 'step failed',
		quarantinedAt: 0,
	}
}

function cascadeEffect(step: { recordId: string }) {
	return {
		type: 'delete' as const,
		collection: 'tasks',
		recordId: step.recordId,
		data: null,
		previousData: null,
		ruleId: 'relation:taskProject:cascade',
	}
}

/** Applies a step on its own, as the per-operation path does (a failing one is reported and skipped). */
async function applyOne(device: Device, step: Step, position: number): Promise<void> {
	if (step.kind === 'retract') {
		await device.store.applyScopeRetraction(step.collection, step.recordId, position + 0.5)
		device.results.push(`retract:${step.recordId}`)
		return
	}
	if (step.kind === 'cascade') {
		device.results.push(
			`cascade:${await device.store.applyProvisionalSideEffects(step.parent, [cascadeEffect(step)])}`,
		)
		return
	}
	try {
		device.results.push(
			`${step.op.id}:${await device.store.applyRemoteOperation(step.op, { deliveryPosition: position })}`,
		)
	} catch (error) {
		device.failed.push(step.op)
		device.results.push(`${step.op.id}:threw:${(error as Error).name}`)
	}
}

async function applyChunk(
	device: Device,
	steps: Step[],
	firstPosition: number,
	prefetch: boolean,
): Promise<void> {
	const failedBefore = device.failed.length
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
			if (step.kind === 'cascade') {
				device.results.push(
					`cascade:${await batch.applyProvisionalSideEffects(step.parent, [cascadeEffect(step)])}`,
				)
				continue
			}
			try {
				device.results.push(
					`${step.op.id}:${await batch.applyRemoteOperation(step.op, { deliveryPosition: position })}`,
				)
			} catch (error) {
				device.failed.push(step.op)
				device.results.push(`${step.op.id}:threw:${(error as Error).name}`)
			}
		}
		// What the engine records with the batch: the quarantine rows and the watermark.
		await batch.saveInboundQuarantine(
			device.failed.slice(failedBefore).map((op) => quarantineEntry(op, firstPosition)),
			{ signature: 'view', watermark: firstPosition + steps.length - 1 },
		)
	})
	expect(outcome).not.toBeNull()
}

/** The reference's equivalent of what the batch recorded, written after its operations. */
async function recordChunk(
	device: Device,
	failedBefore: number,
	firstPosition: number,
	size: number,
): Promise<void> {
	await saveUnappliedOperations(
		device.adapter,
		device.failed.slice(failedBefore).map((op) => quarantineEntry(op, firstPosition)),
		{ signature: 'view', watermark: firstPosition + size - 1 },
	)
}

async function snapshot(device: Device): Promise<unknown> {
	await Promise.allSettled(device.audits)
	const all = async (sql: string): Promise<unknown[]> => device.adapter.query(sql)
	const audits = (
		await all(
			'SELECT id, recorded_at, event_type, collection, record_id, field, strategy, tier, trace_json FROM _kora_audit_traces ORDER BY id',
		)
	).map((row) => {
		const record = row as Record<string, unknown>
		return {
			...record,
			trace_json: JSON.parse(String(record.trace_json), (key, value) =>
				TIMING_FIELDS.has(key) ? undefined : value,
			),
		}
	})
	return {
		todos: await all('SELECT * FROM todos ORDER BY id'),
		notes: await all('SELECT * FROM notes ORDER BY id'),
		projects: await all('SELECT * FROM projects ORDER BY id'),
		tasks: await all('SELECT * FROM tasks ORDER BY id'),
		foldStates: await all('SELECT * FROM _kora_fold_state ORDER BY collection, record_id'),
		todoLog: await all('SELECT * FROM _kora_ops_todos ORDER BY id'),
		noteLog: await all('SELECT * FROM _kora_ops_notes ORDER BY id'),
		projectLog: await all('SELECT * FROM _kora_ops_projects ORDER BY id'),
		taskLog: await all('SELECT * FROM _kora_ops_tasks ORDER BY id'),
		conflicts: await all(
			'SELECT id, collection, reemitted_as FROM _kora_seq_conflicts ORDER BY id',
		),
		retractions: await all('SELECT * FROM _kora_scope_retractions ORDER BY collection, record_id'),
		provisional: await all('SELECT * FROM _kora_provisional_ops ORDER BY id'),
		versionVector: await all('SELECT * FROM _kora_version_vector ORDER BY node_id'),
		unapplied: await all('SELECT * FROM _kora_unapplied_ops ORDER BY op_id'),
		watermark: await all("SELECT * FROM _kora_meta WHERE key LIKE '%watermark%' ORDER BY key"),
		audits,
		memoryVersionVector: [...device.store.getVersionVector()].sort((a, b) =>
			a[0].localeCompare(b[0]),
		),
		events: device.events,
		results: device.results,
	}
}

/** Runs one scenario on a per-operation reference and on the two batched variants. */
async function expectBatchedEqualsPerOperation(scenario: Scenario): Promise<void> {
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
		const failedBefore = reference.failed.length
		for (const [offset, step] of chunk.entries()) {
			await applyOne(reference, step, index + offset + 1)
		}
		await recordChunk(reference, failedBefore, index + 1, chunk.length)
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
}

function remoteOp(
	id: string,
	node: string,
	sequenceNumber: number,
	recordId: string,
	type: Operation['type'],
	data: Record<string, unknown> | null,
	wall: number,
	collection = 'todos',
): Operation {
	return {
		id,
		nodeId: node,
		type,
		collection,
		recordId,
		data,
		previousData: type === 'update' ? {} : null,
		timestamp: { wallTime: wall, logical: 0, nodeId: node },
		sequenceNumber,
		causalDeps: [],
		schemaVersion: 1,
	}
}

describe('a prefetched, buffered delivery batch equals the per-operation apply', () => {
	test('generated operation sets: every merge kind, cascades, atomic ops, failing steps, conflicts', async () => {
		await fc.assert(fc.asyncProperty(scenarioArb, expectBatchedEqualsPerOperation), {
			numRuns: 400,
		})
	}, 600_000)

	test('a sequence number taken by an operation of a fallback-path record (stale holder)', async () => {
		// Op A (n1, 1) lands on a record with a retraction marker, so it takes the per-operation
		// path. Op B (n1, 1, another id) is on a plain record. The per-operation device sees A
		// in the log and keeps B as a sequence conflict; the batch must do the same, not hit the
		// unique index.
		const a = remoteOp('a', 'n1', 1, 'r1', 'insert', { title: 'one' }, 1_001)
		const b = remoteOp('b', 'n1', 1, 'r2', 'insert', { title: 'two' }, 1_002)
		const steps: Step[] = [
			{ kind: 'retract', collection: 'todos', recordId: 'r1' },
			{ kind: 'op', op: a },
			{ kind: 'op', op: b },
		]
		await expectBatchedEqualsPerOperation({ steps, prefix: 0, cuts: [3] })
		const reference = await newDevice()
		const batched = await newDevice()
		for (const [index, step] of steps.entries()) await applyOne(reference, step, index + 1)
		await applyChunk(batched, steps, 1, true)
		expect(batched.results).toEqual(reference.results)
		expect(batched.results.filter((line) => line.includes('threw'))).toEqual([])
		expect(await batched.adapter.query('SELECT id FROM _kora_seq_conflicts')).toEqual([{ id: 'b' }])
	})

	test('an operation the batch never announced reads the transaction', async () => {
		const reference = await newDevice()
		const batched = await newDevice()
		const held = remoteOp('held', 'n1', 1, 'r1', 'insert', { title: 'held' }, 1_001)
		const rival = remoteOp('rival', 'n1', 1, 'r2', 'insert', { title: 'rival' }, 1_002)
		await applyOne(reference, { kind: 'op', op: held }, 1)
		await applyOne(reference, { kind: 'op', op: rival }, 2)
		await batched.store.applyRemoteBatch(async (batch) => {
			// Only `held` is announced; `rival` takes its sequence number and was not read.
			await batch.prefetch([held])
			await batch.applyRemoteOperation(held, { deliveryPosition: 1 })
			await batch.applyRemoteOperation(rival, { deliveryPosition: 2 })
		})
		expect(await batched.adapter.query('SELECT id FROM _kora_seq_conflicts')).toEqual(
			await reference.adapter.query('SELECT id FROM _kora_seq_conflicts'),
		)
	})

	test('a record the batch inserts and then updates sees its own earlier writes', async () => {
		const ops: Operation[] = [
			remoteOp('a', 'n1', 1, 'r1', 'insert', { title: 'one', completed: false, tags: [] }, 1_001),
			remoteOp('b', 'n1', 2, 'r1', 'update', { title: 'two' }, 1_002),
			remoteOp('c', 'n1', 3, 'r1', 'delete', null, 1_003),
		]
		await expectBatchedEqualsPerOperation({
			steps: ops.map((op) => ({ kind: 'op' as const, op })),
			prefix: 0,
			cuts: [3],
		})
	})
})

describe('the prior-operation lookup of merge traces (resolveDeferredPriors)', () => {
	const PRIOR_LOOKUP = 'AS c, id, node_id, type, record_id, data, previous_data'

	class PriorLookupFails extends BetterSqlite3Adapter {
		armed = false
		failures = 0
		override async transaction(fn: (tx: Transaction) => Promise<void>): Promise<void> {
			return super.transaction((tx) =>
				fn({
					execute: (sql, params) => tx.execute(sql, params),
					query: <T>(sql: string, params?: unknown[]) => {
						if (this.armed && sql.includes(PRIOR_LOOKUP)) {
							this.failures++
							return Promise.reject(new Error('prior lookup failed'))
						}
						return tx.query<T>(sql, params)
					},
				}),
			)
		}
	}

	// Documented behavior: the lookup only enriches traces and runs once, after the last step,
	// outside any savepoint. A failure fails the batch as a whole: its transaction rolls back
	// (nothing of the chunk is applied) and the sync engine applies the chunk operation by
	// operation, where each trace reads its own prior. Never a partial chunk.
	test('a failing lookup rolls the whole chunk back; the per-operation path then applies it', async () => {
		const adapter = new PriorLookupFails(':memory:')
		const store = new Store({ schema, adapter, nodeId: 'device' })
		await store.open()
		devices.push({ store, adapter, events: [], results: [], audits: [], failed: [] })
		const first = remoteOp('p1', 'n1', 1, 'r1', 'insert', { title: 'x', stock: 1 }, 1_001)
		const second = remoteOp('p2', 'n2', 1, 'r1', 'update', { title: 'y' }, 1_002)
		const third = remoteOp('p3', 'n3', 1, 'r1', 'update', { title: 'z' }, 1_003)
		await store.applyRemoteOperation(first)
		adapter.armed = true
		await expect(
			store.applyRemoteBatch(async (batch) => {
				await batch.prefetch([second, third])
				await batch.applyRemoteOperation(second, { deliveryPosition: 2 })
				await batch.applyRemoteOperation(third, { deliveryPosition: 3 })
			}),
		).rejects.toThrow('prior lookup failed')
		expect(adapter.failures).toBeGreaterThan(0)
		adapter.armed = false
		expect(await adapter.query('SELECT id FROM _kora_ops_todos')).toHaveLength(1)
		expect(await store.applyRemoteOperation(second, { deliveryPosition: 2 })).toBe('applied')
		expect(await store.applyRemoteOperation(third, { deliveryPosition: 3 })).toBe('applied')
	})
})

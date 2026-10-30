import { appendFileSync, readFileSync } from 'node:fs'
import { fc } from '@fast-check/vitest'
import { defineSchema, op, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'
import type { CollectionRecord, QueryDescriptor } from '../types'
import type { PendingEntry, PendingWrites } from './pending-writes'
import { compare, matches } from './query-eval'
import { GatedAdapter, quiesce } from './test-support'

/**
 * Overlay equivalence (instant-UI S3, design 12.2). Real stores, real SQLite
 * (better-sqlite3, in both materialization modes), real writes through the Collection API,
 * real remote operations from a second store, with every commit under the test's control:
 * a write's COMMIT waits at a gate until the test releases it, fails it, or marks its
 * outcome unknown. No timers: the event loop is only ever yielded with setImmediate.
 *
 * Asserted:
 *  (1) MODEL, after every step: each subscription's displayed rows (and the rows its
 *      callback last received) equal `f(base, applicable entries)` computed by an
 *      independent, slow reference implementation (full re-sorts, no binary search, no
 *      structural sharing).
 *  (2) SETTLE, after everything has committed or failed and every post-commit read has
 *      run: every subscription shows exactly what a fresh SELECT returns, and no entry is
 *      left in the registry.
 *  (3) SOUNDNESS, for the runs where it is defined (every write predicted, none failed,
 *      no remote operation, nothing skipped by the patcher): the rows shown BEFORE the
 *      commits equal the rows after them, modulo `createdAt`/`updatedAt` (the one expected
 *      difference, 5.3d).
 *
 * The gates sit inside the adapter's transaction mutex, so transactions keep the order the
 * writes were called in (as in production); what varies is when each commit lands relative
 * to the reads and remote deliveries queued behind it.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		items: {
			fields: {
				title: t.string(),
				n: t.number().optional(),
				done: t.boolean().default(false),
				tag: t.enum(['x', 'y', 'z']).default('x'),
			},
		},
	},
})

const runs = Number(process.env.KORA_OVERLAY_EQ_RUNS ?? 150)
const seed = process.env.KORA_OVERLAY_EQ_SEED ? Number(process.env.KORA_OVERLAY_EQ_SEED) : undefined

// --- generators ---

type FieldData = { title?: string; n?: number | null; done?: boolean; tag?: 'x' | 'y' | 'z' }

const titleArb = fc.constantFrom('t0', 't1', 't2')
const nArb = fc.option(fc.integer({ min: 0, max: 3 }), { nil: null })
const tagArb = fc.constantFrom('x' as const, 'y' as const, 'z' as const)

const insertDataArb: fc.Arbitrary<FieldData> = fc.record({
	title: titleArb,
	n: nArb,
	done: fc.boolean(),
	tag: tagArb,
})

const updateDataArb: fc.Arbitrary<FieldData> = fc
	.record({ title: titleArb, n: nArb, done: fc.boolean(), tag: tagArb }, { requiredKeys: [] })
	.filter((data) => Object.keys(data).length > 0)

interface QuerySpec {
	where: Record<string, unknown>
	orderBy: Array<[string, 'asc' | 'desc']>
	limit?: number
}

const whereArb = fc.constantFrom<Record<string, unknown>>(
	{},
	{},
	{ done: false },
	{ done: true },
	{ tag: 'x' },
	{ n: { $gt: 1 } },
	{ n: { $lte: 2 } },
	{ tag: { $in: ['x', 'y'] } },
	{ title: { $ne: 't1' } },
	{ done: false, tag: { $ne: 'z' } },
)

const orderArb = fc.constantFrom<Array<[string, 'asc' | 'desc']>>(
	[],
	[['n', 'asc']],
	[['n', 'desc']],
	[
		['n', 'asc'],
		['id', 'asc'],
	],
	[
		['title', 'desc'],
		['id', 'asc'],
	],
	[['createdAt', 'asc']],
	[
		['updatedAt', 'desc'],
		['id', 'asc'],
	],
	[['id', 'asc']],
	[
		['tag', 'asc'],
		['n', 'desc'],
		['id', 'desc'],
	],
)

const specArb: fc.Arbitrary<QuerySpec> = fc
	.record({
		where: whereArb,
		orderBy: orderArb,
		limit: fc.option(fc.integer({ min: 1, max: 4 }), { nil: undefined }),
	})
	.map((spec) => (spec.limit === undefined ? { where: spec.where, orderBy: spec.orderBy } : spec))

/** One write inside a transaction (S6a). `-own` targets the group's own latest insert. */
type GroupOp =
	| { op: 'insert'; data: FieldData }
	| { op: 'update'; target: number; data: FieldData }
	| { op: 'delete'; target: number }
	| { op: 'update-own'; data: FieldData }
	| { op: 'delete-own' }
	/** An atomic op: never predicted, so it makes its whole group a declined group. */
	| { op: 'increment'; target: number }

type Step =
	| { kind: 'group'; ops: GroupOp[] }
	| { kind: 'insert'; data: FieldData }
	| { kind: 'update'; target: number; data: FieldData }
	| { kind: 'delete'; target: number }
	| { kind: 'commit' }
	| { kind: 'fail' }
	| { kind: 'unknown' }
	| { kind: 'remote-insert'; data: FieldData }
	| { kind: 'remote-update'; target: number; data: FieldData }
	| { kind: 'remote-delete'; target: number }
	| { kind: 'tick' }

const groupOpArb: fc.Arbitrary<GroupOp> = fc.oneof(
	{ weight: 4, arbitrary: insertDataArb.map((data): GroupOp => ({ op: 'insert', data })) },
	{
		weight: 3,
		arbitrary: fc
			.tuple(fc.nat(20), updateDataArb)
			.map(([target, data]): GroupOp => ({ op: 'update', target, data })),
	},
	{ weight: 1, arbitrary: fc.nat(20).map((target): GroupOp => ({ op: 'delete', target })) },
	{ weight: 2, arbitrary: updateDataArb.map((data): GroupOp => ({ op: 'update-own', data })) },
	{ weight: 1, arbitrary: fc.constant<GroupOp>({ op: 'delete-own' }) },
	{ weight: 1, arbitrary: fc.nat(20).map((target): GroupOp => ({ op: 'increment', target })) },
)

const stepArb: fc.Arbitrary<Step> = fc.oneof(
	{
		weight: 4,
		arbitrary: fc
			.array(groupOpArb, { minLength: 1, maxLength: 4 })
			.map((ops): Step => ({ kind: 'group', ops })),
	},
	{ weight: 5, arbitrary: insertDataArb.map((data): Step => ({ kind: 'insert', data })) },
	{
		weight: 5,
		arbitrary: fc
			.tuple(fc.nat(20), updateDataArb)
			.map(([target, data]): Step => ({ kind: 'update', target, data })),
	},
	{ weight: 2, arbitrary: fc.nat(20).map((target): Step => ({ kind: 'delete', target })) },
	{ weight: 5, arbitrary: fc.constant<Step>({ kind: 'commit' }) },
	{ weight: 2, arbitrary: fc.constant<Step>({ kind: 'fail' }) },
	{ weight: 1, arbitrary: fc.constant<Step>({ kind: 'unknown' }) },
	{ weight: 1, arbitrary: insertDataArb.map((data): Step => ({ kind: 'remote-insert', data })) },
	{
		weight: 2,
		arbitrary: fc
			.tuple(fc.nat(20), updateDataArb)
			.map(([target, data]): Step => ({ kind: 'remote-update', target, data })),
	},
	{ weight: 1, arbitrary: fc.nat(20).map((target): Step => ({ kind: 'remote-delete', target })) },
	{ weight: 2, arbitrary: fc.constant<Step>({ kind: 'tick' }) },
)

const workloadArb = fc.record({
	initial: fc.array(insertDataArb, { maxLength: 6 }),
	specs: fc.array(specArb, { minLength: 1, maxLength: 5 }),
	steps: fc.array(stepArb, { minLength: 1, maxLength: 30 }),
})

// --- the reference implementation of f(base, entries) ---

function appendAllowed(d: QueryDescriptor): boolean {
	return Object.values(d.where).every(
		(condition) =>
			condition === null ||
			typeof condition !== 'object' ||
			Array.isArray(condition) ||
			Object.keys(condition).every((op) => op === '$eq' || op === '$ne'),
	)
}

/**
 * Slow and independent of `applyOverlay`: copies everything, sorts instead of searching.
 * Transactions (S6a): a group is applied whole or not at all, so when a pass skips any
 * member of a group the model starts again with that group excluded, until stable.
 */
function model(
	base: readonly CollectionRecord[],
	entries: readonly PendingEntry[],
	d: QueryDescriptor,
): CollectionRecord[] {
	const excluded = new Set<string>()
	for (;;) {
		const { rows, skippedGroups } = modelPass(base, entries, d, excluded)
		const fresh = [...skippedGroups].filter((group) => !excluded.has(group))
		if (fresh.length === 0) return rows
		for (const group of fresh) excluded.add(group)
	}
}

function modelPass(
	base: readonly CollectionRecord[],
	entries: readonly PendingEntry[],
	d: QueryDescriptor,
	excluded: ReadonlySet<string>,
): { rows: CollectionRecord[]; skippedGroups: Set<string> } {
	let rows: CollectionRecord[] = base.map((row) => ({ ...row }))
	const limit = d.limit
	const poisoned = new Set<string>()
	const skippedGroups = new Set<string>()
	const skip = (entry: PendingEntry) => {
		poisoned.add(entry.recordId)
		if (entry.groupId !== null) skippedGroups.add(entry.groupId)
	}
	const sort = (list: CollectionRecord[]) => [...list].sort((a, b) => compare(d, a, b))
	for (const entry of entries) {
		if (limit === 0) break
		if (entry.groupId !== null && excluded.has(entry.groupId)) {
			skip(entry)
			continue
		}
		if (poisoned.has(entry.recordId)) {
			skip(entry)
			continue
		}
		const at = rows.findIndex((row) => row.id === entry.recordId)
		const full = limit !== undefined && rows.length >= limit
		if (entry.kind === 'delete') {
			if (at < 0) continue
			if (full) skip(entry)
			else rows.splice(at, 1)
			continue
		}
		const current = at >= 0 ? rows[at] : undefined
		const source = entry.kind === 'insert' || !current ? entry.record : entry.patch
		const next: CollectionRecord = current
			? {
					...current,
					...Object.fromEntries(Object.entries(source ?? {}).filter(([k]) => k !== 'id')),
				}
			: { ...entry.record }
		if (!matches(d, next)) {
			if (current) {
				if (full) skip(entry)
				else rows.splice(at, 1)
			}
			continue
		}
		if (!current) {
			if (entry.kind === 'update') {
				const before = { ...entry.record, ...(entry.previous ?? {}) }
				if (entry.previous === null || (matches(d, before) && !full)) {
					skip(entry)
					continue
				}
			}
			if (d.orderBy.length === 0) {
				if (entry.kind !== 'insert' || !appendAllowed(d)) {
					skip(entry)
					continue
				}
				if (!full) rows.push(next)
				continue
			}
			if (rows.some((row) => compare(d, row, next) === 0)) {
				skip(entry)
				continue
			}
			const sorted = sort([...rows, next])
			if (limit !== undefined && sorted.indexOf(next) >= limit) continue
			rows = sorted
			if (limit !== undefined && rows.length > limit) rows.length = limit
			continue
		}
		if (JSON.stringify(next) === JSON.stringify(current)) continue
		if (d.orderBy.length === 0 || compare(d, current, next) === 0) {
			rows[at] = next
			continue
		}
		const others = rows.filter((_, index) => index !== at)
		if (others.some((row) => compare(d, row, next) === 0)) {
			skip(entry)
			continue
		}
		const sorted = sort([...others, next])
		if (full && sorted.indexOf(next) >= others.length) {
			skip(entry)
			continue
		}
		rows = sorted
	}
	return { rows, skippedGroups }
}

/** A null `n` means "no value": omitted on insert, `undefined` (clears the field) on update. */
function toWrite(data: FieldData, update: boolean): Record<string, unknown> {
	const { n, ...rest } = data
	if (n === null) return update ? { ...rest, n: undefined } : rest
	return { ...data }
}

const strip = (rows: readonly CollectionRecord[]) =>
	rows.map(({ createdAt: _c, updatedAt: _u, ...rest }) => rest)

// --- the harness ---

interface Counters {
	runs: number
	soundnessChecked: number
	withSkips: number
	withMisses: number
	withFails: number
	withRemote: number
	steps: number
	patchedDeliveries: number
	/** Transactions predicted as one entry group / declined as a whole (S6a). */
	groupsPredicted: number
	groupsDeclined: number
	/** Runs where a predicted group was rolled back. */
	withGroupRollback: number
}

const counters: Counters = {
	runs: 0,
	soundnessChecked: 0,
	withSkips: 0,
	withMisses: 0,
	withFails: 0,
	withRemote: 0,
	steps: 0,
	patchedDeliveries: 0,
	groupsPredicted: 0,
	groupsDeclined: 0,
	withGroupRollback: 0,
}

async function runWorkload(
	materialization: 'fold' | 'legacy',
	workload: { initial: FieldData[]; specs: QuerySpec[]; steps: Step[] },
): Promise<void> {
	const adapter = new GatedAdapter(':memory:')
	const peerAdapter = new BetterSqlite3Adapter(':memory:')
	const emitter = new SimpleEventEmitter()
	const peerEmitter = new SimpleEventEmitter()
	const store = new Store({
		schema,
		adapter,
		nodeId: 'node-a',
		emitter,
		materialization,
		instantUpdates: true,
		// A read the write path may not wait on: an update with no known base is not predicted.
		// Not strict: a remote write landing in the same millisecond as a local one can look like a
		// divergence; clean workloads (no remote, no failure) must report none, asserted below.
		instantUpdatesInternals: { readRecord: async () => null, strict: false },
	})
	const peer = new Store({
		schema,
		adapter: peerAdapter,
		nodeId: 'node-b',
		emitter: peerEmitter,
		materialization,
	})
	let divergences = 0
	emitter.on('store:overlay-diverged', () => {
		divergences++
	})
	let groupRolledBack = false
	// Transactions issued, announced (registered or declined) and refused in their callback:
	// one whose callback still waits behind a held commit has not reached its prediction.
	let groupsIssued = 0
	let groupsAnnounced = 0
	let groupsThrew = 0
	emitter.on('store:write-pending', (event) => {
		if (event.kind !== 'transaction') return
		groupsAnnounced += 1
		if (event.predicted) counters.groupsPredicted += 1
		else counters.groupsDeclined += 1
	})
	emitter.on('store:write-settled', (event) => {
		if (event.collections !== undefined && event.outcome === 'rolled-back') groupRolledBack = true
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
	// A's committed operations reach the peer, the peer's reach A (through the gated adapter).
	emitter.on('operation:created', (event) => absorb(peer.applyRemoteOperation(event.operation)))
	peerEmitter.on('operation:created', (event) => {
		remoteOps.push(event.operation)
		absorb(store.applyRemoteOperation(event.operation))
	})
	const remoteOps: Operation[] = []

	const items = store.collection('items')
	const peerItems = peer.collection('items')
	const knownIds: string[] = []
	for (const data of workload.initial) knownIds.push((await items.insert(toWrite(data, false))).id)
	await quiesce()
	registry.settleCollection('items', registry.epoch)

	const seen: CollectionRecord[][][] = []
	const builders = workload.specs.map((spec) => {
		let query = items.where(spec.where)
		for (const [field, direction] of spec.orderBy) query = query.orderBy(field, direction)
		if (spec.limit !== undefined) query = query.limit(spec.limit)
		return query
	})
	builders.forEach((query, index) => {
		seen[index] = []
		query.subscribe((rows) => seen[index]?.push([...rows]))
	})
	await quiesce()
	store.getSubscriptionManager().configureOverlay({ now: () => 0 })
	adapter.gating = true

	// Known ids include the ids of inserts as soon as they are registered.
	const noteInserts = () => {
		for (const entry of registry.list()) {
			if (entry.kind === 'insert' && !knownIds.includes(entry.recordId)) {
				knownIds.push(entry.recordId)
			}
		}
	}
	const pickId = (target: number): string | undefined =>
		knownIds.length === 0 ? undefined : knownIds[target % knownIds.length]

	// The peer is a separate store without an overlay: its writes never register in A's registry.
	const asPeer = async (write: () => Promise<unknown>) => {
		try {
			await write()
		} catch {
			// a peer write on a record it does not hold (yet) is a no-op step
		}
	}

	const writes: Array<Promise<unknown>> = []
	const track = (promise: Promise<unknown>) => writes.push(promise.catch(() => {}))
	let failed = false
	let remote = false

	const checkModel = (when: string) => {
		const states = store.getSubscriptionManager().inspectOverlay()
		states.forEach((state, index) => {
			if (!state.base || state.baseIssuedAt === undefined) return
			const entries = registry.applicable('items', state.baseIssuedAt)
			const last = seen[index]?.at(-1)
			if (last) {
				expect(last, `${when}: callback != displayed for query ${index}`).toEqual(state.displayed)
			}
			const expected = model(state.base, entries, state.descriptor)
			expect(state.displayed, `${when}: displayed != f(base, entries) for query ${index}`).toEqual(
				expected,
			)
		})
	}

	let stepNumber = 0
	for (const step of workload.steps) {
		stepNumber += 1
		switch (step.kind) {
			case 'group': {
				// One transaction (what app.transaction / app.mutation run). Its reads queue behind
				// held commits, so its group registers only once those land: like production.
				const targets = step.ops.map((one) => ('target' in one ? pickId(one.target) : undefined))
				groupsIssued += 1
				track(
					store
						.transaction(async (tx) => {
							const txItems = tx.collection('items')
							let own: string | null = null
							for (const [index, one] of step.ops.entries()) {
								const target = targets[index]
								switch (one.op) {
									case 'insert':
										own = (await txItems.insert(toWrite(one.data, false))).id
										break
									case 'update':
										if (target) await txItems.update(target, toWrite(one.data, true))
										break
									case 'delete':
										if (target) await txItems.delete(target)
										break
									case 'update-own':
										if (own) await txItems.update(own, toWrite(one.data, true))
										break
									case 'delete-own':
										if (own) await txItems.delete(own)
										own = null
										break
									case 'increment':
										if (target) await txItems.update(target, { n: op.increment(1) })
										break
								}
							}
						})
						.catch((error: unknown) => {
							if (!(error instanceof Error) || !/injected/.test(error.message)) groupsThrew += 1
							throw error
						}),
				)
				break
			}
			case 'insert':
				track(items.insert(toWrite(step.data, false)))
				break
			case 'update': {
				const id = pickId(step.target)
				if (id) track(items.update(id, toWrite(step.data, true)))
				break
			}
			case 'delete': {
				const id = pickId(step.target)
				if (id) track(items.delete(id))
				break
			}
			case 'commit':
				adapter.gates.shift()?.release()
				break
			case 'fail':
				failed = failed || adapter.gates.length > 0
				adapter.gates.shift()?.fail()
				break
			case 'unknown': {
				const oldest = registry.list().find((entry) => entry.state === 'pending')
				if (oldest) registry.markUnknown(oldest.writeId)
				break
			}
			case 'remote-insert':
				remote = true
				await asPeer(() => peerItems.insert(toWrite(step.data, false)))
				break
			case 'remote-update': {
				remote = true
				const id = pickId(step.target)
				if (id) await asPeer(() => peerItems.update(id, toWrite(step.data, true)))
				break
			}
			case 'remote-delete': {
				remote = true
				const id = pickId(step.target)
				if (id) await asPeer(() => peerItems.delete(id))
				break
			}
			case 'tick':
				break
		}
		await quiesce()
		noteInserts()
		checkModel(`after step ${stepNumber} (${step.kind})`)
		counters.steps += 1
	}

	// SOUNDNESS: what is shown now, with every outstanding write still waiting at its gate.
	const stats = store.getSubscriptionManager().getOverlayStats()
	const predictedAll = registry.misses.size === 0
	const clean =
		!failed &&
		!remote &&
		predictedAll &&
		stats.skippedEntries === 0 &&
		groupsAnnounced + groupsThrew === groupsIssued
	const shownBefore = store
		.getSubscriptionManager()
		.inspectOverlay()
		.map((state) => state.displayed.map((row) => ({ ...row })))

	// Let everything land.
	adapter.autoRelease = true
	for (const gate of adapter.gates.splice(0)) gate.release()
	for (let i = 0; i < 6; i++) {
		await Promise.all([...writes, ...background])
		await quiesce()
	}
	checkModel('after the drain')

	// SETTLE: every subscription equals a fresh SELECT; nothing is left over.
	const fresh = await Promise.all(builders.map((query) => query.exec()))
	const afterStates = store.getSubscriptionManager().inspectOverlay()
	afterStates.forEach((state, index) => {
		expect(
			state.displayed,
			`settled display of query ${index} (${JSON.stringify(workload.specs[index])}) != SELECT`,
		).toEqual(fresh[index])
	})
	expect(registry.list(), 'entries left after settle').toEqual([])
	expect(registry.pendingCount).toBe(0)

	if (clean) {
		counters.soundnessChecked += 1
		expect(divergences, 'a clean workload reports no divergence').toBe(0)
		shownBefore.forEach((rows, index) => {
			// Ordered by createdAt/updatedAt, the order of rows written in one millisecond
			// is the prediction's (equal timestamps, id order) until the commit assigns the
			// real ones: checked modulo order for such queries, not exactly.
			const spec = workload.specs[index]
			if (spec?.orderBy.some(([field]) => field === 'createdAt' || field === 'updatedAt')) {
				const byId = (list: readonly CollectionRecord[]) =>
					strip(list).sort((x, y) => String(x.id).localeCompare(String(y.id)))
				if (spec.limit === undefined) {
					expect(byId(rows), `membership before != after, query ${index}`).toEqual(
						byId(fresh[index] ?? []),
					)
				}
				return
			}
			expect(
				strip(rows),
				`shown before the commits != after, query ${index} (${JSON.stringify(workload.specs[index])})`,
			).toEqual(strip(fresh[index] ?? []))
		})
	}
	counters.runs += 1
	if (stats.skippedEntries > 0) counters.withSkips += 1
	if (!predictedAll) counters.withMisses += 1
	if (failed) counters.withFails += 1
	if (groupRolledBack) counters.withGroupRollback += 1
	if (remote) counters.withRemote += 1
	counters.patchedDeliveries += store.getSubscriptionManager().getOverlayStats().patchedDeliveries

	await store.close()
	await peer.close()
}

for (const materialization of ['fold', 'legacy'] as const) {
	describe(`overlay equivalence on a controllable adapter (${materialization})`, () => {
		test(`model, settle and soundness hold over ${runs} generated workloads`, async () => {
			const before = { ...counters }
			await fc.assert(
				fc.asyncProperty(workloadArb, (workload) => runWorkload(materialization, workload)),
				{ numRuns: runs, ...(seed !== undefined ? { seed } : {}) },
			)
			const ran = counters.runs - before.runs
			if (process.env.KORA_OVERLAY_EQ_REPORT) {
				// vitest swallows console output here; a path in the variable gets the counters.
				appendFileSync(
					process.env.KORA_OVERLAY_EQ_REPORT,
					`${materialization}: ${JSON.stringify(counters)}\n`,
				)
			}
			// Guard against a vacuous pass: the interesting paths must actually be hit.
			expect(ran).toBeGreaterThanOrEqual(Math.min(runs, 20))
			expect(counters.soundnessChecked - before.soundnessChecked).toBeGreaterThan(ran / 10)
			expect(counters.patchedDeliveries - before.patchedDeliveries).toBeGreaterThan(ran)
			expect(counters.withFails - before.withFails).toBeGreaterThan(0)
			expect(counters.withRemote - before.withRemote).toBeGreaterThan(0)
			expect(counters.withSkips - before.withSkips).toBeGreaterThan(0)
			// S6a: transactions were predicted as groups, declined as groups, and rolled back.
			expect(counters.groupsPredicted - before.groupsPredicted).toBeGreaterThan(ran / 5)
			expect(counters.groupsDeclined - before.groupsDeclined).toBeGreaterThan(0)
			expect(counters.withGroupRollback - before.withGroupRollback).toBeGreaterThan(0)
		}, 300_000)
	})
}

// Replay one counterexample fast-check printed: KORA_OVERLAY_EQ_REPRO=<file with the printed counterexample> vitest run -t replay
if (process.env.KORA_OVERLAY_EQ_REPRO) {
	for (const materialization of ['fold', 'legacy'] as const) {
		test(`replay of KORA_OVERLAY_EQ_REPRO (${materialization})`, async () => {
			const workload = JSON.parse(readFileSync(process.env.KORA_OVERLAY_EQ_REPRO ?? '', 'utf8'))
			await runWorkload(materialization, workload)
		})
	}
}

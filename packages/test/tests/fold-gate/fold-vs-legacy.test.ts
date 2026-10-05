/**
 * W7 step 7: the beta.12 pipeline (`experimental.legacyMerge`) and the W7 fold,
 * compared on random workloads.
 *
 * Each seed runs a workload through real devices (./workload.ts), collects the
 * record's operations, and replays the SAME operation set into a fresh fold store
 * and a fresh legacy store, each in two random causal orders. Per field:
 *   - the fold must agree with itself in every order (and with the devices);
 *   - where the legacy pipeline disagrees with itself, the difference is the
 *     legacy non-convergence the fold fixes (MERGE-2) and is reported as such;
 *   - where legacy is stable but differs from the fold, the difference must be
 *     explained by a documented semantic change for that field kind (fold.ts
 *     header, docs/guide/conflict-resolution.md); a difference on a plain scalar
 *     field is unexplained and fails the test.
 * The summary is printed so CI shows what changed and why.
 */
import { HybridLogicalClock } from '@korajs/core'
import type { Operation, SchemaDefinition } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { MergeEngine } from '@korajs/merge'
import { Store } from '@korajs/store'
import { BetterSqlite3Adapter } from '@korajs/store/better-sqlite3'
import { ApplyPipeline } from 'korajs/testing'
import { describe, expect, test } from 'vitest'
import {
	FIELD_KIND,
	type GateField,
	type Rng,
	mulberry32,
	normalizeRecord,
	runSeeds,
	runWorkload,
} from './workload'

const SEEDS = Number(process.env.KORA_FOLD_COMPARE_SEEDS ?? 40)
const SEED_BASE = Number(process.env.KORA_FOLD_COMPARE_SEED_BASE ?? 0x636d70)

/** Documented semantic changes that can explain a fold/legacy difference, per field kind. */
const EXPLANATIONS: Record<string, string> = {
	array: '#1 arrays are occurrence multisets merged per element (order = first add)',
	'append-only': '#7 append-only is folded over every write; #1 multiset elements',
	object: '#2 objects/json merge per top-level key; nested values whole-value LWW',
	counter: '#7 counter = base + every delta (not a pairwise formula)',
	extremum: '#7 max/min = extremum of every write',
	resolver: '#4 resolvers fold in HLC order with local = merged state',
	richtext: 'richtext is the Yjs merge of every update (legacy merged pairwise)',
	atomic: '#7/#8 atomic chains fold over every write in HLC order',
}

/** A random linear extension of the causal order (what a sync delivery looks like). */
function causalOrder(ops: readonly Operation[], rng: Rng): Operation[] {
	const ids = new Set(ops.map((op) => op.id))
	const pending = [...ops]
	const done = new Set<string>()
	const out: Operation[] = []
	while (pending.length > 0) {
		const ready = pending.filter((op) =>
			op.causalDeps.every((dep) => !ids.has(dep) || done.has(dep)),
		)
		const pool = ready.length > 0 ? ready : pending
		const next = pool[Math.floor(rng() * pool.length)] as Operation
		pending.splice(pending.indexOf(next), 1)
		done.add(next.id)
		out.push(next)
	}
	return out
}

/** Record-level LWW: the newest insert/update is later than the newest delete. */
function newestWriteBeatsDelete(ops: readonly Operation[]): boolean {
	const later = (a: Operation | null, b: Operation): Operation =>
		a === null ||
		HybridLogicalClock.compare(b.timestamp, a.timestamp) > 0 ||
		(HybridLogicalClock.compare(b.timestamp, a.timestamp) === 0 && b.id > a.id)
			? b
			: a
	let write: Operation | null = null
	let del: Operation | null = null
	for (const op of ops) {
		if (op.type === 'delete') del = later(del, op)
		else write = later(write, op)
	}
	if (write === null) return false
	return del === null || later(del, write) === write
}

/** The value of the newest (HLC, then id) write that changed `field`. */
function newestScalarWrite(ops: readonly Operation[], field: string): unknown {
	let newest: Operation | null = null
	for (const op of ops) {
		if (op.type === 'delete' || !op.data || !(field in op.data)) continue
		if (
			op.type === 'update' &&
			op.previousData &&
			JSON.stringify(op.previousData[field]) === JSON.stringify(op.data[field])
		) {
			continue
		}
		if (
			newest === null ||
			HybridLogicalClock.compare(op.timestamp, newest.timestamp) > 0 ||
			(HybridLogicalClock.compare(op.timestamp, newest.timestamp) === 0 && op.id > newest.id)
		) {
			newest = op
		}
	}
	return newest?.data?.[field] ?? null
}

async function replay(
	ops: readonly Operation[],
	schema: SchemaDefinition,
	fields: readonly GateField[],
	legacy: boolean,
	rng: Rng,
): Promise<Record<string, unknown> | null> {
	const store = new Store({
		schema,
		adapter: new BetterSqlite3Adapter(':memory:'),
		emitter: new SimpleEventEmitter(),
		materialization: legacy ? 'legacy' : 'fold',
	})
	await store.open()
	try {
		const pipeline = new ApplyPipeline({ store, emitter: null, mergeEngine: new MergeEngine() })
		store.setLocalMutationHandler(pipeline)
		for (const op of causalOrder(ops, rng)) await pipeline.applyRemote(op)
		const recordId = ops[0]?.recordId ?? ''
		return normalizeRecord(await store.collection('items').findById(recordId), fields)
	} finally {
		await store.close()
	}
}

interface Difference {
	seed: number
	field: string
	kind: string
	reason: string
}

describe('W7 fold vs legacy pipeline on random workloads', () => {
	test(`${SEEDS} seeds: every difference is explained by a documented semantic change`, async () => {
		const results = await runSeeds(SEED_BASE, SEEDS, 20, (seed) => runWorkload(seed))
		const differences: Difference[] = []
		const unexplained: Difference[] = []
		for (const result of results) {
			const rng = mulberry32(result.seed ^ 0x5eed)
			const fold = await Promise.all([
				replay(result.operations, result.schema, result.fields, false, rng),
				replay(result.operations, result.schema, result.fields, false, rng),
			])
			const legacy = await Promise.all([
				replay(result.operations, result.schema, result.fields, true, rng),
				replay(result.operations, result.schema, result.fields, true, rng),
			])
			// The fold is order-independent and equals what the devices converged to.
			expect(JSON.stringify(fold[0])).toBe(JSON.stringify(fold[1]))
			expect(JSON.stringify(fold[0])).toBe(JSON.stringify(result.oracle))
			const folded = fold[0]
			const [legacyA, legacyB] = legacy
			if ((folded === null) !== (legacyA === null)) {
				// Record level: live iff the newest write is later than the newest delete
				// (unchanged semantics). A fold that follows it is right.
				const entry = {
					seed: result.seed,
					field: '*',
					kind: 'record',
					reason: `liveness differs: fold ${folded === null ? 'deleted' : 'live'}`,
				}
				if ((folded !== null) === newestWriteBeatsDelete(result.operations)) {
					differences.push({
						...entry,
						reason: 'legacy broke record-level LWW (delete vs newer update); the fold keeps it',
					})
				} else {
					unexplained.push(entry)
				}
				continue
			}
			if (folded === null || legacyA === null) continue
			for (const field of result.fields) {
				const f = JSON.stringify(folded[field])
				const a = JSON.stringify(legacyA[field])
				const b = JSON.stringify(legacyB?.[field])
				if (f === a && f === b) continue
				const kind = FIELD_KIND[field]
				if (a !== b) {
					differences.push({
						seed: result.seed,
						field,
						kind,
						reason: 'legacy is order-dependent here (MERGE-2); the fold converges',
					})
					continue
				}
				// #3: an update restating a field unchanged is not a write in the fold;
				// the legacy store resolved it by LWW like a change.
				const restated = result.operations.some(
					(op) =>
						op.type === 'update' &&
						op.data !== null &&
						op.previousData !== null &&
						field in op.data &&
						JSON.stringify(op.data[field]) === JSON.stringify(op.previousData[field]),
				)
				// A plain scalar must be the newest write by HLC. When the fold is and the
				// legacy pipeline is not, legacy lost a newer write (its pairwise path).
				const lossOfNewest =
					kind === 'scalar' &&
					f === JSON.stringify(newestScalarWrite(result.operations, field)) &&
					a !== f
				const explanation = restated
					? '#3 an unchanged restated field is not a write'
					: lossOfNewest
						? 'legacy lost the newest write (pairwise path); the fold keeps LWW'
						: EXPLANATIONS[kind]
				const entry = {
					seed: result.seed,
					field,
					kind,
					reason: explanation ?? `unexplained: fold ${f} vs legacy ${a}`,
				}
				if (explanation) differences.push(entry)
				else unexplained.push(entry)
			}
		}
		const byReason = new Map<string, number>()
		for (const difference of differences) {
			const key = `${difference.kind}: ${difference.reason}`
			byReason.set(key, (byReason.get(key) ?? 0) + 1)
		}
		console.info(
			`fold vs legacy over ${results.length} seeds: ${differences.length} explained difference(s), ${unexplained.length} unexplained\n${[
				...byReason,
			]
				.map(([reason, count]) => `  ${count} x ${reason}`)
				.join('\n')}`,
		)
		expect(unexplained).toEqual([])
	}, 600_000)
})

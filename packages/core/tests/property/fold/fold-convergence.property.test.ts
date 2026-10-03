/**
 * W7 convergence gate (fix plan W7 "Tests to green": the convergence gate at 200
 * seeds across every field kind).
 *
 * Each seed generates a random schema (a subset of every field kind: scalars,
 * enum, timestamps incl. auto, arrays, objects, json, atomic ops, counter / max /
 * min / append-only / server-authoritative strategies, custom resolvers including
 * a non-commutative and a throwing one, richtext as opaque updates, secrets) and a
 * random op stream from 2-4 nodes: inserts, updates with real previousData,
 * deletes, insert onto an existing row, concurrent same-field writes, equal wall
 * times, and very late offline ops. The gate asserts, per seed:
 *   - every replica (random delivery order + duplicates + reloads) reaches the
 *     same state, byte for byte, and the oracle's record (commutativity,
 *     idempotency);
 *   - folding from scratch equals merging incrementally;
 *   - joining partition folds in either grouping equals folding everything
 *     (associativity);
 *   - folding with an exclusion set equals folding without those ops.
 *
 * Seeds are fixed so CI is deterministic. KORA_FOLD_SEEDS / KORA_FOLD_SEED_BASE
 * widen or move the sweep (nightly).
 */
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { makeW7Fold, w7Fold } from './fold-impl'
import {
	type GateAuthority,
	type GateField,
	generateScenario,
	naiveArrivalOrderFold,
	oracleMaterialize,
	runGateSeed,
} from './harness'

const SEEDS = Number(process.env.KORA_FOLD_SEEDS ?? 200)
const SEED_BASE = Number(process.env.KORA_FOLD_SEED_BASE ?? 0x4b6f7261)

describe('W7 convergence gate', () => {
	test(
		`all field kinds converge for ${SEEDS} seeds`,
		() => {
			const failures = []
			for (let i = 0; i < SEEDS; i++) {
				const failure = runGateSeed(w7Fold, (SEED_BASE + i) >>> 0)
				if (failure) failures.push(failure)
			}
			expect(failures.slice(0, 3)).toEqual([])
		},
		Math.max(60_000, SEEDS * 20),
	)

	test('the gate rejects a naive arrival-order fold (it has teeth)', () => {
		let rejected = 0
		for (let i = 0; i < 50; i++) {
			if (runGateSeed(naiveArrivalOrderFold, (SEED_BASE + i) >>> 0)) rejected++
		}
		expect(rejected).toBeGreaterThan(40)
	})

	// Per-kind gates (CLAUDE.md: property tests for commutativity, associativity and
	// idempotency per kind), driven by fast-check with a fixed seed.
	const KIND_GROUPS: Array<[string, GateField[]]> = [
		[
			'scalar LWW (string/boolean/enum/timestamp/auto/secret)',
			['title', 'done', 'prio', 'due', 'createdAt', 'pin'],
		],
		['number with atomic ops', ['count']],
		['array LWW element set', ['tags']],
		['array with atomic append/remove', ['nums']],
		['object per-key LWW', ['meta']],
		['json per-key LWW with shape changes', ['doc']],
		['counter strategy', ['score']],
		['max / min strategies', ['hi', 'lo']],
		['append-only strategy', ['log']],
		['server-authoritative strategy', ['auth']],
		['custom resolvers (additive, order-sensitive, throwing)', ['inv', 'label', 'risky']],
		['richtext opaque updates + string resets', ['body']],
	]
	// Authority by the reserved `kora:server:` prefix (Phase 3, RT-61/62 shared rule):
	// a server node is authoritative without being listed, so replicas that never
	// learned its id (or learned a different explicit list) still fold identically.
	const AUTHORITY_CASES: Array<[string, GateAuthority]> = [
		[
			'prefix only (no explicit list)',
			{
				nodeName: (i) => (i === 1 ? 'kora:server:main' : `node-${i}`),
				authoritative: new Set(),
			},
		],
		[
			'prefix node plus a legacy listed node',
			{
				nodeName: (i) => (i === 0 ? 'kora:server:main' : `node-${i}`),
				authoritative: new Set(['node-2']),
			},
		],
		[
			'a bare "kora:server:" id is not a server node',
			{
				nodeName: (i) => (i === 1 ? 'kora:server:' : `node-${i}`),
				authoritative: new Set(),
			},
		],
	]
	for (const [name, authority] of AUTHORITY_CASES) {
		test(`server-authoritative by node-id prefix: ${name}`, () => {
			const impl = makeW7Fold(authority.authoritative)
			fc.assert(
				fc.property(fc.integer({ min: 0, max: 0x7fffffff }), (seed) => {
					expect(runGateSeed(impl, seed, ['title', 'auth', 'count'], authority)).toBeNull()
				}),
				{ numRuns: 80, seed: SEED_BASE },
			)
		})
	}

	test('the prefix rule has teeth: folding prefix nodes as plain LWW diverges', () => {
		const authority: GateAuthority = {
			nodeName: (i) => (i === 1 ? 'kora:server:main' : `node-${i}`),
			authoritative: new Set(),
		}
		// The same streams with the server node renamed out of the namespace (what a
		// list-only fold that never learned the id sees) must fold differently on some
		// seeds, or the prefix cases above would prove nothing.
		let disagreements = 0
		for (let i = 0; i < 80; i++) {
			const seed = (SEED_BASE + i) >>> 0
			const scenario = generateScenario(seed, ['title', 'auth'], authority.nodeName)
			const prefixAware = JSON.stringify(
				oracleMaterialize(scenario.ops, scenario.schema, undefined, new Set()),
			)
			const listOnly = JSON.stringify(
				oracleMaterialize(
					scenario.ops.map((op) =>
						op.nodeId === 'kora:server:main'
							? {
									...op,
									nodeId: 'renamed',
									timestamp: { ...op.timestamp, nodeId: 'renamed' },
								}
							: op,
					),
					scenario.schema,
					undefined,
					new Set(),
				),
			)
			if (prefixAware !== listOnly) disagreements++
		}
		expect(disagreements).toBeGreaterThan(0)
	})

	for (const [name, fields] of KIND_GROUPS) {
		test(`per-kind: ${name}`, () => {
			fc.assert(
				fc.property(fc.integer({ min: 0, max: 0x7fffffff }), (seed) => {
					const failure = runGateSeed(w7Fold, seed, ['title', ...fields])
					expect(failure).toBeNull()
				}),
				{ numRuns: 60, seed: SEED_BASE },
			)
		})
	}
})

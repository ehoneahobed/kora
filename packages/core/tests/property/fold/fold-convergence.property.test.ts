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
import { w7Fold } from './fold-impl'
import { type GateField, naiveArrivalOrderFold, runGateSeed } from './harness'

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

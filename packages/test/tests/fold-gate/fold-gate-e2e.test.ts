/**
 * W7 convergence gate, END TO END (fix plan W7 "Tests to green": the convergence
 * gate at 200 seeds across every field kind, through real apps).
 *
 * Every seed runs a randomized multi-device workload (see ./workload.ts) through
 * real TestDevices (Store + fold + ApplyPipeline + SyncEngine) and the TestServer,
 * then asserts:
 *   - every device holds the same operations for the record;
 *   - every device materializes the same record (byte for byte, richtext as text);
 *   - that record equals the from-scratch fold of the union of the logs (the
 *     persisted, incremental client pipeline == the reference fold).
 * The server's own materialization is compared in fold-gate-server.test.ts (B2).
 *
 * KORA_FOLD_E2E_SEEDS / KORA_FOLD_E2E_SEED_BASE widen or move the sweep (nightly).
 */
import { describe, expect, test } from 'vitest'
import { type WorkloadResult, runSeeds, runWorkload } from './workload'

const SEEDS = Number(process.env.KORA_FOLD_E2E_SEEDS ?? 200)
const SEED_BASE = Number(process.env.KORA_FOLD_E2E_SEED_BASE ?? 0x6b6f7261)
const PARALLEL = Number(process.env.KORA_FOLD_E2E_PARALLEL ?? 25)

function failureOf(result: WorkloadResult): string | null {
	const views = Object.entries(result.devices)
	const first = JSON.stringify(views[0]?.[1] ?? null)
	const detail = () =>
		`seed=${result.seed} fields=${result.fields.join(',')}\n${views
			.map(([name, view]) => `${name}=${JSON.stringify(view)}`)
			.join('\n')}\noracle=${JSON.stringify(result.oracle)}\n${result.log.join('\n')}`
	if (!result.sameLogs) return `logs differ: ${detail()}`
	if (views.some(([, view]) => JSON.stringify(view) !== first))
		return `devices diverge: ${detail()}`
	if (JSON.stringify(result.oracle) !== first) return `device != reference fold: ${detail()}`
	return null
}

describe('W7 convergence gate through real devices', () => {
	test(
		`${SEEDS} seeds, every field kind: devices converge to the reference fold`,
		async () => {
			const results = await runSeeds(SEED_BASE, SEEDS, PARALLEL, (seed) => runWorkload(seed))
			const failures = results.map(failureOf).filter((failure) => failure !== null)
			const kinds = new Set(results.flatMap((result) => result.fields))
			// Every field kind was exercised.
			if (SEEDS >= 50) expect(kinds.size).toBe(15)
			expect(failures.slice(0, 2)).toEqual([])
		},
		Math.max(300_000, SEEDS * 4_000),
	)

	test('the gate rejects the beta.13 pairwise pipeline (it has teeth)', async () => {
		const results = await runSeeds(SEED_BASE, 25, 25, (seed) =>
			runWorkload(seed, { legacyMerge: true }),
		)
		const diverged = results.filter((result) => {
			const views = Object.values(result.devices).map((view) => JSON.stringify(view))
			return new Set(views).size > 1
		})
		const failures = results.filter((result) => failureOf(result) !== null)
		// Legacy devices diverge from each other on some seeds, and from the fold on most.
		expect(diverged.length).toBeGreaterThan(0)
		expect(failures.length).toBeGreaterThan(10)
	}, 300_000)
})

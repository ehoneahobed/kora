import { expect } from 'vitest'

/**
 * True on a shared CI runner (GitHub-hosted), where the workflow sets
 * KORA_BENCH_SHARED_RUNNER=1. Such runners vary in speed from run to run by more than a
 * gate's 10% buffer, so a gate whose target sits within that variance cannot be enforced
 * absolutely there; scripts/bench/ab-regression.mjs enforces it relatively instead.
 */
const SHARED_RUNNER = process.env.KORA_BENCH_SHARED_RUNNER === '1'

/** Options for {@link expectTimingGate}. */
export interface TimingGateOptions {
	/**
	 * On a shared runner, report a miss as a warning instead of failing. Only for gates
	 * the relative check (ab-regression.mjs) covers: everywhere else (locally, on a
	 * dedicated runner) the absolute target is enforced.
	 */
	advisoryOnSharedRunner?: boolean
}

/**
 * Enforce an absolute timing gate (CLAUDE.md target x 1.1) and report the measurement
 * (as a GitHub annotation on CI, so run-to-run variance is visible without the logs).
 *
 * @param label - The gate, as named in docs/benchmarks/baseline.md
 * @param measuredMs - What this run measured
 * @param limitMs - The gate (target x REGRESSION_FACTOR)
 * @param options - Whether a miss on a shared runner is only a warning
 */
export function expectTimingGate(
	label: string,
	measuredMs: number,
	limitMs: number,
	options: TimingGateOptions = {},
): void {
	const report = `${label}: ${measuredMs.toFixed(1)} ms (limit ${limitMs.toFixed(1)} ms)`
	if (process.env.GITHUB_ACTIONS === 'true') console.log(`::notice title=benchmark::${report}`)
	if (SHARED_RUNNER && options.advisoryOnSharedRunner && measuredMs >= limitMs) {
		console.log(
			`::warning title=benchmark::${report}. Over the absolute target on a shared runner; the head-vs-base check (ab-regression.mjs) decides.`,
		)
		return
	}
	expect(measuredMs, report).toBeLessThan(limitMs)
}

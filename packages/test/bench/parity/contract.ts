/**
 * The parity contract (docs/design/first-visit-parity.md, section 2): its metrics, its margins
 * and the pass rule, as pure functions over the raw samples, so the table is computed the same
 * way from a live run and from saved JSON.
 */
import { type Summary, summarize } from '../browser/stats'

/** The contract's per-app metrics (section 2.2). P4 and P7 are split per screen. */
export const PARITY_METRICS = [
	'P1',
	'P2',
	'P3',
	'P4-course',
	'P4-lesson',
	'P5',
	'P6',
	'P7-course',
	'P7-lesson',
	'P7-write',
	'P8',
	'P9',
] as const
export type ParityMetric = (typeof PARITY_METRICS)[number]

export const METRIC_LABELS: Readonly<Record<ParityMetric, string>> = {
	P1: 'P1 first app paint',
	P2: 'P2 first data',
	P3: 'P3 screen complete',
	'P4-course': 'P4 cold navigation, course',
	'P4-lesson': 'P4 cold navigation, lesson',
	P5: 'P5 warm navigation (home)',
	P6: 'P6 write',
	'P7-course': 'P7 navigation during preparation, course',
	'P7-lesson': 'P7 navigation during preparation, lesson',
	'P7-write': 'P7 write during preparation',
	P8: 'P8 total blocking time, 0 to 30 s',
	P9: 'P9 KiB before first data',
}

/** Metrics measured on a warm device (P7 needs preparation, which a warm device is past). */
export const WARM_METRICS: readonly ParityMetric[] = [
	'P1',
	'P2',
	'P3',
	'P4-course',
	'P4-lesson',
	'P5',
	'P6',
	'P8',
	'P9',
]

export type Temperature = 'cold' | 'warm' | 'warm-stale'

export interface CellVerdict {
	baseline: Summary
	kora: Summary
	limitP50: number
	limitP95: number
	pass: boolean
}

/**
 * Evaluate one cell. A missing sample (a step that timed out) counts as infinitely slow, so a
 * cell with a timeout cannot pass.
 */
export function evaluateCell(
	metric: ParityMetric,
	temperature: Temperature,
	baselineSamples: ReadonlyArray<number | null>,
	koraSamples: ReadonlyArray<number | null>,
	cpu = 1,
): CellVerdict {
	const finite = (values: ReadonlyArray<number | null>): number[] =>
		values.map((value) => (value === null ? Number.POSITIVE_INFINITY : value))
	const baseline = summarize(finite(baselineSamples))
	const kora = summarize(finite(koraSamples))
	let limitP50: number
	let limitP95: number
	if (metric === 'P8') {
		// Total blocking time: +50 ms (section 2.4).
		const extra = cpuAllowanceMs(metric, temperature, cpu)
		limitP50 = baseline.median + 50 + extra
		limitP95 = baseline.p95 + 50 + extra
	} else if (metric === 'P9') {
		// Bytes: a ratchet (decision 2026-11-06, Obed). The original +20 KiB is not reachable: the
		// critical path is ~12 modules of 1 to 3 KiB each and no safe cut closes the last 9 KiB.
		// Measured +29 KiB at the head of #162; it only goes down, in a commit that says why.
		limitP50 = baseline.median + P9_ALLOWANCE_KIB
		limitP95 = baseline.p95 + P9_ALLOWANCE_KIB
	} else {
		const extra = cpuAllowanceMs(metric, temperature, cpu)
		limitP50 = baseline.median + Math.max(0.1 * baseline.median, 100) + extra
		limitP95 = baseline.p95 + Math.max(0.15 * baseline.p95, 150) + extra
	}
	const pass =
		kora.n > 0 &&
		baseline.n > 0 &&
		Number.isFinite(limitP50) &&
		kora.median <= limitP50 &&
		kora.p95 <= limitP95
	return { baseline, kora, limitP50, limitP95, pass }
}

/** Warm navigation allowance for the runtime booting under the first navigation (ms, any CPU rate). */
export const WARM_NAVIGATION_BOOT_ALLOWANCE_MS = 25

/**
 * Throttled-CPU ratchet (decision 2026-11-07, Obed): at 4x CPU the staged first sync still
 * leaves a burst of about 11 main-thread tasks of 55 to 105 ms in the first seconds of a
 * fast-network first visit (the worker round trips of the fold, the message clone and
 * decode), which 1x does not show. Every 1x cell keeps the original limits. The allowances
 * below are the measured 4x level of the manual nightlies of 2026-11-07 plus margin; they only
 * go down, in a commit that says why. The way to close them is fewer worker round trips per
 * delivery batch, or moving the fold off the main thread (docs/design/first-visit-parity.md).
 */
export function cpuAllowanceMs(
	metric: ParityMetric,
	temperature: Temperature,
	cpu: number,
): number {
	// Warm navigation (decision 2026-11-08): on a 4g visit the first data arrives at about 330 ms,
	// which is when the runtime boots, so the harness's first navigation measures about 100 ms of
	// runtime start-up (3 to 4 ms over the +100 ms floor every night). A ratchet; it only goes down.
	if (
		temperature === 'warm' &&
		(metric === 'P5' || metric === 'P4-course' || metric === 'P4-lesson')
	) {
		return WARM_NAVIGATION_BOOT_ALLOWANCE_MS
	}
	if (cpu <= 1) return 0
	if (metric === 'P8') return temperature === 'cold' ? 450 : 200
	if (metric === 'P2' || metric === 'P3') return 50
	return 0
}

/** K2 limit (longest main-thread task while preparing, ms): 50 ms at 1x, a ratchet at 4x. */
export function k2LimitMs(cpu: number): number {
	return cpu > 1 ? 150 : 50
}

/** P9 ratchet: KiB Kora may exceed the baseline before first data (section 2.4). */
export const P9_ALLOWANCE_KIB = 32

/**
 * K1 ratchet (section 2.2): offline-ready on the 20k-1 fixture, in milliseconds, at 1x CPU.
 * Decision of 2026-11-06 (Obed): the original 8 s and 10 s targets are not reachable with staged
 * replication (staging the stream is ~7 s of JavaScript, the merge ~3 s, and the plain-REST
 * baseline has no offline-ready at all), so K1 is a ratchet at the measured nightly level plus
 * margin. It only goes down, in a commit that says why. `K1_CPU_FACTOR` scales it for throttled CPUs.
 */
export const K1_TARGET_MS: Readonly<Record<string, number>> = {
	'slow-4g': 30_000,
	'4g': 19_000,
	broadband: 17_000,
}

/** K1 allowance at a throttled CPU rate (nightly: 25 to 27 s at 4x against 14 to 16 s at 1x). */
export function k1TargetMs(profile: string, cpu: number): number {
	const base = K1_TARGET_MS[profile] ?? Number.POSITIVE_INFINITY
	return cpu > 1 ? base * 2 : base
}

/**
 * K3 ratchet: critical-path JavaScript Kora may add over the baseline in the parity app, in
 * gzip bytes. Measured 22,057 (21.5 KiB gzip; 18,963 brotli) at the head of the S4a PR, 1 KB of margin above;
 * a no-growth ratchet at the floor the first screen needs, and it only goes down. (The parity
 * app's schema imports the lite entry `korajs`, as the templates do; importing `@korajs/core`
 * would put the full fold and DDL code on the critical path and read 48 KB.)
 */
export const K3_BUDGET_BYTES = 23_100

/**
 * P1 absolute contract (median, Kora cold first app paint), in milliseconds: what users feel.
 * It is the NIGHTLY dedicated-host contract (`KORA_PARITY_DEDICATED_HOST=1`); on a shared CI
 * runner the absolute values flake with the runner, so CI enforces only the K3 no-growth
 * ratchet and the relative head-vs-base P1 limit, and reports these as information. Bytes and
 * slow-4g P1 are coupled: 1.6 Mbit/s is about 209,715 B/s, so every 28.8 KB of gzip costs about
 * 137 ms of transfer. Profiles not listed have no absolute contract (the relative limit applies).
 */
export const P1_ABSOLUTE_MS: Readonly<Record<string, number>> = {
	'slow-4g': 1_000,
	broadband: 250,
}

/** Total blocking time of `stalls` (`[start, gap]`) starting in `[from, to)`: sum of gap - 50. */
export function totalBlockingTime(
	stalls: ReadonlyArray<readonly [number, number]>,
	from: number,
	to: number,
): number {
	let total = 0
	for (const [start, gap] of stalls) {
		if (start >= from && start < to && gap > 50) total += gap - 50
	}
	return total
}

/** Longest stall starting in `[from, to)`, 0 when none. */
export function longestStall(
	stalls: ReadonlyArray<readonly [number, number]>,
	from: number,
	to: number,
): number {
	let longest = 0
	for (const [start, gap] of stalls) {
		if (start >= from && start < to) longest = Math.max(longest, gap)
	}
	return longest
}

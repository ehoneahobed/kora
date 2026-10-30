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

/** Metrics where a warm Kora must be at or below the baseline at p50 (section 2.4). */
const WARM_AT_OR_BELOW: ReadonlySet<ParityMetric> = new Set([
	'P2',
	'P3',
	'P4-course',
	'P4-lesson',
	'P5',
	'P6',
])

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
): CellVerdict {
	const finite = (values: ReadonlyArray<number | null>): number[] =>
		values.map((value) => (value === null ? Number.POSITIVE_INFINITY : value))
	const baseline = summarize(finite(baselineSamples))
	const kora = summarize(finite(koraSamples))
	let limitP50: number
	let limitP95: number
	if (metric === 'P8') {
		// Total blocking time: +50 ms (section 2.4).
		limitP50 = baseline.median + 50
		limitP95 = baseline.p95 + 50
	} else if (metric === 'P9') {
		// Bytes: K3's 20 KB (the read-through envelope does not exist yet).
		limitP50 = baseline.median + 20
		limitP95 = baseline.p95 + 20
	} else {
		limitP50 = baseline.median + Math.max(0.1 * baseline.median, 100)
		limitP95 = baseline.p95 + Math.max(0.15 * baseline.p95, 150)
		if (temperature !== 'cold' && WARM_AT_OR_BELOW.has(metric)) {
			limitP50 = Math.min(limitP50, baseline.median)
		}
	}
	const pass =
		kora.n > 0 &&
		baseline.n > 0 &&
		Number.isFinite(limitP50) &&
		kora.median <= limitP50 &&
		kora.p95 <= limitP95
	return { baseline, kora, limitP50, limitP95, pass }
}

/** K1 targets (section 2.2): offline-ready on the 20k-1 fixture, in milliseconds. */
export const K1_TARGET_MS: Readonly<Record<string, number>> = {
	'slow-4g': 30_000,
	'4g': 10_000,
	broadband: 8_000,
}

/** K3: critical-path JavaScript Kora may add over the baseline, in gzip bytes. */
export const K3_BUDGET_BYTES = 20 * 1024

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

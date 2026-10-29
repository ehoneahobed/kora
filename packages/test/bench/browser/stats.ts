/** Summary of a sample: median and nearest-rank p95 (the maximum when there are 20 or fewer values). */
export interface Summary {
	n: number
	median: number
	p95: number
	min: number
	max: number
}

/** Nearest-rank percentile of an unsorted sample. */
export function percentile(values: readonly number[], p: number): number {
	if (values.length === 0) return Number.NaN
	const sorted = [...values].sort((a, b) => a - b)
	const rank = Math.max(1, Math.ceil(p * sorted.length))
	return sorted[Math.min(sorted.length, rank) - 1] as number
}

/** Median (mean of the middle two for an even count) and p95 of a sample. */
export function summarize(values: readonly number[]): Summary {
	const sorted = [...values].sort((a, b) => a - b)
	const n = sorted.length
	const median =
		n === 0
			? Number.NaN
			: n % 2 === 1
				? (sorted[(n - 1) / 2] as number)
				: ((sorted[n / 2 - 1] as number) + (sorted[n / 2] as number)) / 2
	return {
		n,
		median,
		p95: percentile(sorted, 0.95),
		min: sorted[0] ?? Number.NaN,
		max: sorted[n - 1] ?? Number.NaN,
	}
}

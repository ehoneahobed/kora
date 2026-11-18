/**
 * The head-vs-base regression decision for one metric (see ab-regression.mjs): the medians of
 * each side's alternating runs. One run disturbed by a noisy neighbour, faster or slower, does
 * not move a median of five; a real slowdown moves every run, and so the median.
 *
 * @param {number[]} baseRuns - The base checkout's timings, in ms
 * @param {number[]} headRuns - The head checkout's timings, in ms
 * @param {{ maxRegression: number, slackMs: number }} limits
 * @returns {{ baseMs: number, headMs: number, change: number, regressed: boolean }}
 */
export function decide(baseRuns, headRuns, { maxRegression, slackMs }) {
	const baseMs = median(baseRuns)
	const headMs = median(headRuns)
	const change = headMs / baseMs - 1
	return { baseMs, headMs, change, regressed: change > maxRegression && headMs - baseMs > slackMs }
}

/** Median (mean of the middle two for an even count). */
function median(values) {
	const sorted = [...values].sort((a, b) => a - b)
	const middle = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

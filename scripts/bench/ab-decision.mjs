/**
 * The head-vs-base regression decision for one metric (see ab-regression.mjs).
 *
 * @param {number[]} baseRuns - The base checkout's timings, in ms
 * @param {number[]} headRuns - The head checkout's timings, in ms
 * @param {{ maxRegression: number, slackMs: number }} limits
 * @returns {{ baseMs: number, headMs: number, change: number, regressed: boolean }}
 */
export function decide(baseRuns, headRuns, { maxRegression, slackMs }) {
	const baseMs = Math.min(...baseRuns)
	const headMs = Math.min(...headRuns)
	const change = headMs / baseMs - 1
	return { baseMs, headMs, change, regressed: change > maxRegression && headMs - baseMs > slackMs }
}

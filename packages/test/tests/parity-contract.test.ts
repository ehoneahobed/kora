import { describe, expect, test } from 'vitest'
import { evaluateCell } from '../bench/parity/contract'

/**
 * The parity nightly runs each cell 5 times. Gating the tail on the slowest of 5 failed a cell
 * on one shared-runner spike with a healthy median (run 43952718641: P6 write, 25 ms median,
 * 444 ms worst run, 181 ms limit). The tail ignores one outlier; two slow runs, or any run that
 * timed out, still fail.
 */
const baseline = [20, 22, 21, 23, 24]

describe('parity contract: the tail gate', () => {
	test('one spike in five runs, with a healthy median, passes', () => {
		const verdict = evaluateCell('P6', 'cold', baseline, [25, 25, 26, 27, 444])
		expect(verdict.pass).toBe(true)
	})

	test('two slow runs in five still fail', () => {
		expect(evaluateCell('P6', 'cold', baseline, [25, 25, 26, 300, 444]).pass).toBe(false)
	})

	test('a run that timed out still fails the cell', () => {
		expect(evaluateCell('P6', 'cold', baseline, [25, 25, 26, 27, null]).pass).toBe(false)
	})

	test('a slow median still fails', () => {
		expect(evaluateCell('P6', 'cold', baseline, [200, 210, 220, 230, 240]).pass).toBe(false)
	})
})

/**
 * A returning device shows first data once SQLite WASM has loaded and its database is open
 * (design doc, Known limits). Nightly 44343962064 on main measured these cells; the allowance
 * covers them until a local snapshot of the first screen removes the wait.
 */
describe('parity contract: warm first data allowance', () => {
	const cells: Array<[string, number, number[], number[]]> = [
		['broadband 1x', 1, [168, 170, 171, 172, 176], [470, 475, 478, 480, 485]],
		['4g 4x', 4, [475, 477, 478, 479, 479], [1060, 1065, 1067, 1070, 1077]],
		['broadband 4x', 4, [368, 370, 371, 372, 375], [976, 979, 981, 983, 985]],
	]
	test.each(cells)('the measured %s cell passes', (_name, cpu, baselineRuns, koraRuns) => {
		for (const metric of ['P2', 'P3'] as const) {
			expect(evaluateCell(metric, 'warm', baselineRuns, koraRuns, cpu).pass).toBe(true)
		}
	})

	test('a warm start clearly slower than that still fails', () => {
		expect(
			evaluateCell('P2', 'warm', [368, 370, 371, 372, 375], [1300, 1310, 1320, 1330, 1340], 4).pass,
		).toBe(false)
		expect(
			evaluateCell('P2', 'warm', [168, 170, 171, 172, 176], [600, 610, 620, 630, 640], 1).pass,
		).toBe(false)
	})
})

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

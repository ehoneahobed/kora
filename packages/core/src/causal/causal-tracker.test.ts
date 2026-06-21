import { describe, expect, test } from 'vitest'
import { CausalTracker } from './causal-tracker'

describe('CausalTracker', () => {
	test('sequential ops in same collection chain deps', () => {
		const tracker = new CausalTracker()
		const deps1 = tracker.nextCausalDeps('todos', false)
		expect(deps1).toEqual([])
		tracker.afterOperation('todos', 'op-1', false)

		const deps2 = tracker.nextCausalDeps('todos', false)
		expect(deps2).toEqual(['op-1'])
	})

	test('transaction ops depend on prior ops in txn and collection head', () => {
		const tracker = new CausalTracker()
		tracker.afterOperation('todos', 'op-a', false)

		tracker.beginTransaction()
		const depsB = tracker.nextCausalDeps('todos', true)
		expect(depsB).toEqual(['op-a'])
		tracker.afterOperation('todos', 'op-b', true)

		const depsC = tracker.nextCausalDeps('projects', true)
		expect(depsC).toEqual(['op-b'])
	})

	test('large transaction keeps bounded causal deps per op', () => {
		const tracker = new CausalTracker()
		tracker.beginTransaction()
		for (let index = 0; index < 10_000; index++) {
			const deps = tracker.nextCausalDeps('todos', true)
			expect(deps.length).toBeLessThanOrEqual(2)
			tracker.afterOperation('todos', `op-${index}`, true)
		}
	})
})

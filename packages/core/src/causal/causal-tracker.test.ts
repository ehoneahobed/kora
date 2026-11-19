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

describe('CausalTracker.remapIds', () => {
	test('moves heads to the rewritten ids, and its undo puts them back unless they moved on', () => {
		const tracker = new CausalTracker()
		tracker.afterOperation('todos', 'old-a', false)
		tracker.afterOperation('notes', 'old-b', false)
		const undo = tracker.remapIds({ 'old-a': 'new-a', 'old-b': 'new-b' })
		expect(tracker.nextCausalDeps('todos', false)).toEqual(['new-a'])
		// A write after the remap moved `notes` on: the undo leaves that head alone.
		tracker.afterOperation('notes', 'later', false)
		undo()
		expect(tracker.nextCausalDeps('todos', false)).toEqual(['old-a'])
		expect(tracker.nextCausalDeps('notes', false)).toEqual(['later'])
	})
})

describe('CausalTracker.hold', () => {
	test('settling is a promise while held, resolved and cleared by the release', async () => {
		const tracker = new CausalTracker()
		expect(tracker.settling).toBeNull()
		const release = tracker.hold()
		const waiting = tracker.settling
		expect(waiting).toBeInstanceOf(Promise)
		let settled = false
		void waiting?.then(() => {
			settled = true
		})
		await Promise.resolve()
		expect(settled).toBe(false)
		release()
		await waiting
		expect(settled).toBe(true)
		expect(tracker.settling).toBeNull()
		release() // idempotent
	})
})

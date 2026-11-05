import { describe, expect, it } from 'vitest'
import { preReadyWritesAllowed, runAllowingPreReadyWrites } from './pre-ready-writes'

describe('pre-ready write scope', () => {
	it('is closed outside a hook mutation', () => {
		expect(preReadyWritesAllowed()).toBe(false)
	})

	it('is open for the synchronous part of the callback and returns its value', () => {
		const seen = runAllowingPreReadyWrites(() => preReadyWritesAllowed())
		expect(seen).toBe(true)
		expect(preReadyWritesAllowed()).toBe(false)
	})

	it('nests, and restores the outer scope when the inner one ends', () => {
		runAllowingPreReadyWrites(() => {
			runAllowingPreReadyWrites(() => {
				expect(preReadyWritesAllowed()).toBe(true)
			})
			expect(preReadyWritesAllowed()).toBe(true)
		})
		expect(preReadyWritesAllowed()).toBe(false)
	})

	it('closes the scope when the callback throws', () => {
		expect(() =>
			runAllowingPreReadyWrites(() => {
				throw new Error('boom')
			}),
		).toThrow('boom')
		expect(preReadyWritesAllowed()).toBe(false)
	})
})

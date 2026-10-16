import { describe, expect, test } from 'vitest'
import { AccessIndexReadiness } from './access-index-readiness'

describe('AccessIndexReadiness', () => {
	test('one hold finishing never releases another', async () => {
		const readiness = new AccessIndexReadiness()
		let finishFirst = (): void => {}
		const first = readiness.hold(
			() =>
				new Promise<void>((resolve) => {
					finishFirst = resolve
				}),
		)
		// A second operation fails before changing anything: it must not release the first.
		await expect(
			readiness.hold(async () => {
				throw new Error('refused early')
			}),
		).rejects.toThrow('refused early')
		expect(readiness.isReady()).toBe(false)
		finishFirst()
		await first
		expect(readiness.isReady()).toBe(true)
	})

	test('a failure after a change keeps it not ready until a rebuild succeeds', async () => {
		const readiness = new AccessIndexReadiness()
		await expect(
			readiness.hold(async (mutated) => {
				mutated()
				throw new Error('re-fold failed')
			}),
		).rejects.toThrow('re-fold failed')
		expect(readiness.isReady()).toBe(false)
		readiness.rebuilt('g1', false)
		expect(readiness.isReady()).toBe(true)
		expect(readiness.generation()).toBe('g1')
	})

	test("another instance's marker keeps it not ready; an older read never rewinds a rebuild", () => {
		const readiness = new AccessIndexReadiness()
		const before = readiness.rebuildCount()
		readiness.seen('g1', true, before)
		expect(readiness.isReady()).toBe(false)
		readiness.rebuilt('g2', false)
		// A read started before the rebuild resolves late: ignored.
		readiness.seen('g1', true, before)
		expect(readiness.isReady()).toBe(true)
		expect(readiness.generation()).toBe('g2')
	})
})

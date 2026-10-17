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
		// A second operation, queued behind it, fails before changing anything.
		const second = readiness.hold(async () => {
			throw new Error('refused early')
		})
		expect(readiness.isReady()).toBe(false)
		// Let the first hold start (holds begin on their turn, asynchronously).
		await new Promise((resolve) => setTimeout(resolve, 0))
		finishFirst()
		await first
		await expect(second).rejects.toThrow('refused early')
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
		readiness.rebuilt('g1', false, [])
		expect(readiness.isReady()).toBe(true)
		expect(readiness.generation()).toBe('g1')
	})

	test("another instance's marker keeps it not ready; an older read never rewinds a rebuild", () => {
		const readiness = new AccessIndexReadiness()
		const before = readiness.rebuildCount()
		readiness.seen('g1', true, before)
		expect(readiness.isReady()).toBe(false)
		readiness.rebuilt('g2', false, [])
		// A read started before the rebuild resolves late: ignored.
		readiness.seen('g1', true, before)
		expect(readiness.isReady()).toBe(true)
		expect(readiness.generation()).toBe('g2')
	})

	test('holds of one instance run one at a time, each with its own marker', async () => {
		const readiness = new AccessIndexReadiness()
		const order: string[] = []
		const markers: string[] = []
		let releaseFirst = (): void => {}
		const first = readiness.hold(async (mutated) => {
			mutated()
			markers.push(readiness.ownMarker('m:', 'node'))
			order.push('first:start')
			await new Promise<void>((resolve) => {
				releaseFirst = resolve
			})
			// The first rebuild commits: it removes only markers of holds that have run.
			expect(readiness.removableMarkers()).toEqual([markers[0]])
			readiness.rebuilt('g1', false, readiness.removableMarkers())
			order.push('first:end')
		})
		const second = readiness.hold(async () => {
			order.push('second:start')
			markers.push(readiness.ownMarker('m:', 'node'))
			readiness.rebuilt('g2', false, readiness.removableMarkers())
		})
		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(order).toEqual(['first:start'])
		releaseFirst()
		await Promise.all([first, second])
		expect(order).toEqual(['first:start', 'first:end', 'second:start'])
		expect(markers[0]).not.toBe(markers[1])
		expect(readiness.removableMarkers()).toEqual([])
		expect(readiness.isReady()).toBe(true)
	})
})

import { afterEach, describe, expect, test, vi } from 'vitest'
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

	describe('abandoned rebuild recovery', () => {
		afterEach(() => {
			vi.useRealTimers()
		})

		test('a failed recovery is reported and retried only after a growing backoff', async () => {
			vi.useFakeTimers({ toFake: ['Date'] })
			vi.setSystemTime(0)
			const readiness = new AccessIndexReadiness()
			const errors: unknown[] = []
			let attempts = 0
			const failing = async (): Promise<void> => {
				attempts += 1
				throw new Error('install failed')
			}
			readiness.recoverAbandoned(failing, (error) => errors.push(error))
			// Not twice at once.
			readiness.recoverAbandoned(failing, (error) => errors.push(error))
			await readiness.pendingRecovery()
			expect(attempts).toBe(1)
			expect(errors).toHaveLength(1)
			// Within the backoff (2 s after one failure), reads start nothing.
			vi.setSystemTime(1_999)
			readiness.recoverAbandoned(failing, (error) => errors.push(error))
			expect(readiness.pendingRecovery()).toBeNull()
			vi.setSystemTime(2_000)
			readiness.recoverAbandoned(failing, (error) => errors.push(error))
			await readiness.pendingRecovery()
			expect(attempts).toBe(2)
			// The backoff doubles (4 s after a second failure).
			vi.setSystemTime(5_999)
			readiness.recoverAbandoned(failing, (error) => errors.push(error))
			expect(readiness.pendingRecovery()).toBeNull()
		})

		test('no recovery starts while this instance holds the index', async () => {
			const readiness = new AccessIndexReadiness()
			let release = (): void => {}
			const held = readiness.hold(
				() =>
					new Promise<void>((resolve) => {
						release = resolve
					}),
			)
			readiness.recoverAbandoned(
				async () => {},
				() => {},
			)
			expect(readiness.pendingRecovery()).toBeNull()
			await new Promise((resolve) => setTimeout(resolve, 0))
			release()
			await held
		})
	})

	test('marker leases are renewed between the steps of a rebuild that blocks the event loop', async () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(0)
		try {
			const renewed: string[][] = []
			const readiness = new AccessIndexReadiness((keys) => {
				renewed.push([...keys])
			}, 20_000)
			await readiness.hold(async () => {
				readiness.ownMarker('m:', 'node')
				readiness.adopt(['m:gone:1'])
				readiness.renewIfDue()
				expect(renewed).toHaveLength(0)
				vi.setSystemTime(20_000)
				readiness.renewIfDue()
				expect(renewed).toHaveLength(1)
				expect(renewed[0]).toHaveLength(2)
			})
			// The hold ended: nothing renews any more.
			vi.setSystemTime(60_000)
			readiness.renewIfDue()
			expect(renewed).toHaveLength(1)
		} finally {
			vi.useRealTimers()
		}
	})

	test('a hold after a failed one renews the markers that failure left', async () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(0)
		try {
			const renewed: string[][] = []
			const readiness = new AccessIndexReadiness((keys) => {
				renewed.push([...keys])
			}, 20_000)
			let left = ''
			await expect(
				readiness.hold(async (mutated) => {
					left = readiness.ownMarker('m:', 'node')
					mutated()
					throw new Error('failed part-way')
				}),
			).rejects.toThrow('failed part-way')
			// The retry writes no marker of its own (its first step was already committed).
			await readiness.hold(async () => {
				vi.setSystemTime(20_000)
				readiness.renewIfDue()
			})
			expect(renewed).toEqual([[left]])
		} finally {
			vi.useRealTimers()
		}
	})
})

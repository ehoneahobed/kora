import { describe, expect, test } from 'vitest'
import { WriteOrder } from './write-order'

/** Settle every ready microtask chain (no timers). */
async function turns(count = 8): Promise<void> {
	for (let i = 0; i < count; i++) await Promise.resolve()
}

describe('WriteOrder', () => {
	test('a write that needs no read and meets no held record takes no turn', () => {
		const order = new WriteOrder()
		const turn = order.enter(['items\0a'])
		expect(turn.wait).toBeNull()
		expect(order.busy).toBe(false)
		turn.release()
		expect(order.busy).toBe(false)
	})

	test('a write of the same record waits for the earlier one that is reading', async () => {
		const order = new WriteOrder()
		const log: string[] = []
		const first = order.enter(['items\0a'])
		first.hold()
		const second = order.enter(['items\0a'])
		expect(second.wait).not.toBeNull()
		void second.wait?.then(() => log.push('second starts'))
		await turns()
		expect(log).toEqual([])
		log.push('first starts')
		first.release()
		await turns()
		expect(log).toEqual(['first starts', 'second starts'])
		second.release()
		expect(order.busy).toBe(false)
	})

	test('a chain on one record starts in call order', async () => {
		const order = new WriteOrder()
		const started: number[] = []
		const turnsOf = [order.enter(['k'])]
		turnsOf[0]?.hold()
		turnsOf.push(order.enter(['k']), order.enter(['k']))
		for (const [index, turn] of turnsOf.entries()) {
			if (index === 0) continue
			void turn.wait?.then(() => {
				started.push(index)
				turn.release()
			})
		}
		await turns()
		expect(started).toEqual([])
		started.push(0)
		turnsOf[0]?.release()
		await turns(20)
		expect(started).toEqual([0, 1, 2])
	})

	test('independent records are not serialised', async () => {
		const order = new WriteOrder()
		const turnsOf = Array.from({ length: 500 }, (_, index) => order.enter([`items\0${index}`]))
		for (const turn of turnsOf) turn.hold()
		// All 500 are reading at once, and none waited for another.
		expect(turnsOf.every((turn) => turn.wait === null)).toBe(true)
		const other = order.enter(['items\0other'])
		expect(other.wait).toBeNull()
		for (const turn of turnsOf) turn.release()
		expect(order.busy).toBe(false)
	})

	test('a write of another record does not wait for a held record', () => {
		const order = new WriteOrder()
		const reading = order.enter(['items\0a'])
		reading.hold()
		expect(order.enter(['items\0b']).wait).toBeNull()
		reading.release()
	})

	test('a delete waits for every held record (its cascades reach others)', async () => {
		const order = new WriteOrder()
		const reading = order.enter(['children\0c'])
		reading.hold()
		const removal = order.enter(['parents\0p'], { all: true })
		expect(removal.wait).not.toBeNull()
		let started = false
		void removal.wait?.then(() => {
			started = true
		})
		await turns()
		expect(started).toBe(false)
		reading.release()
		await turns()
		expect(started).toBe(true)
		removal.release()
	})

	test('a transaction touching several records waits for each of them', async () => {
		const order = new WriteOrder()
		const a = order.enter(['a'])
		a.hold()
		const b = order.enter(['b'])
		b.hold()
		const group = order.enter(['a', 'b'])
		let started = false
		void group.wait?.then(() => {
			started = true
		})
		a.release()
		await turns()
		expect(started).toBe(false)
		b.release()
		await turns()
		expect(started).toBe(true)
		group.release()
	})

	test('release is idempotent and frees the waiters when the holder gave up (error path)', async () => {
		const order = new WriteOrder()
		const failing = order.enter(['k'])
		failing.hold()
		const next = order.enter(['k'])
		let started = false
		void next.wait?.then(() => {
			started = true
		})
		// The holder failed before starting its transaction: its `finally` releases.
		failing.release()
		failing.release()
		await turns()
		expect(started).toBe(true)
		next.release()
		expect(order.busy).toBe(false)
	})
})

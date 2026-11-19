import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createEarlyRead } from './early-read'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

// Parity nightly on main (4G cold, 4x CPU): the first query mounted ~45 ms after createApp and was
// sent at ~90 ms. A 50 ms cap released the answers chunk first, so the read opened its own
// connection beside it and first data lost ~10 ms to the baseline.
describe('the answers chunk waits for a slow first screen to send its read', () => {
	test('a query that mounts 90 ms after createApp is sent before the chunk may load', async () => {
		vi.useFakeTimers()
		const order: string[] = []
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				order.push('read sent')
				return new Promise(() => {})
			}),
		)
		const early = createEarlyRead({ url: 'ws://example.test/sync' }, schema, Promise.resolve(true))
		void early.firstSend.then(() => order.push('chunk may load'))

		await vi.advanceTimersByTimeAsync(90)
		early.ask({ collection: 'todos', where: {}, orderBy: [] } as never)
		await vi.advanceTimersByTimeAsync(400)

		expect(order).toEqual(['read sent', 'chunk may load'])
	})

	test('a screen that asks nothing still releases the chunk', async () => {
		vi.useFakeTimers()
		const early = createEarlyRead({ url: 'ws://example.test/sync' }, schema, Promise.resolve(true))
		let released = false
		void early.firstSend.then(() => {
			released = true
		})
		await vi.advanceTimersByTimeAsync(300)
		expect(released).toBe(true)
	})
})

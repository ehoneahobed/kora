import { describe, expect, test, vi } from 'vitest'
import { LateSubscriptions, onlyChanges } from './late-subscriptions'

describe('LateSubscriptions', () => {
	test('attaches at once when the target exists, later when it does not', () => {
		const subs = new LateSubscriptions()
		let target: (() => void) | null = null
		const attach = vi.fn(() => target)
		subs.add(null, attach)
		expect(attach).toHaveBeenCalledTimes(1)
		target = () => {}
		subs.flush()
		expect(attach).toHaveBeenCalledTimes(2)
		subs.flush()
		expect(attach).toHaveBeenCalledTimes(2)
	})

	test('flush(true) tells a subscriber once, so one that read the placeholder catches up', () => {
		const subs = new LateSubscriptions()
		const notify = vi.fn()
		subs.add(notify, () => null)
		subs.flush()
		expect(notify).not.toHaveBeenCalled()
		subs.flush(true)
		expect(notify).toHaveBeenCalledTimes(1)
	})

	test('an unsubscribed listener is not told, and a throwing one does not stop the others', () => {
		const subs = new LateSubscriptions()
		const gone = vi.fn()
		const thrower = vi.fn(() => {
			throw new Error('boom')
		})
		const last = vi.fn()
		const off = subs.add(gone, () => null)
		subs.add(thrower, () => null)
		subs.add(last, () => null)
		off()
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		subs.flush(true)
		expect(gone).not.toHaveBeenCalled()
		expect(last).toHaveBeenCalledTimes(1)
		error.mockRestore()
	})
})

describe('onlyChanges', () => {
	test('drops a value equal to the last one delivered, and delivers A, B, A', () => {
		const heard: string[] = []
		const listener = onlyChanges<{ state: string }>((value) => heard.push(value.state))
		listener({ state: 'a' })
		listener({ state: 'a' })
		listener({ state: 'b' })
		listener({ state: 'a' })
		expect(heard).toEqual(['a', 'b', 'a'])
	})

	test('delivers a value with no JSON form instead of swallowing it', () => {
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		const listener = vi.fn()
		const wrapped = onlyChanges(listener)
		wrapped(cyclic)
		wrapped(cyclic)
		expect(listener).toHaveBeenCalledTimes(2)
	})
})

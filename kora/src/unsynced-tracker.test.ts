import { SimpleEventEmitter } from '@korajs/core/internal'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { type UnsyncedCountSource, wireUnsyncedTracking } from './unsynced-tracker'

function fakeEngine(initial = 0): UnsyncedCountSource & {
	set(n: number): void
} {
	let pending = initial
	const listeners = new Set<() => void>()
	return {
		getStatus: () => ({ pendingOperations: pending }),
		onStatusChange(listener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		set(n) {
			pending = n
			for (const listener of listeners) listener()
		},
	}
}

describe('wireUnsyncedTracking', () => {
	const calls: Array<[number, boolean]> = []
	const record = async (count: number, exact: boolean): Promise<void> => {
		calls.push([count, exact])
	}
	afterEach(() => {
		calls.length = 0
		vi.unstubAllGlobals()
	})

	test('a local-only app counts every write and records on the first one', () => {
		const emitter = new SimpleEventEmitter()
		const off = wireUnsyncedTracking({ emitter, engine: null, initialCount: 0, record })
		expect(calls).toEqual([[0, true]])
		emitter.emit({ type: 'operation:created', operation: {} as never })
		emitter.emit({ type: 'operation:created', operation: {} as never })
		// Crossing zero is recorded once; the stale count is flagged as such.
		expect(calls).toEqual([
			[0, true],
			[1, false],
		])
		off()
	})

	test('hiding the page records the exact count of a local-only app', () => {
		const target = new EventTarget()
		vi.stubGlobal('window', target)
		const emitter = new SimpleEventEmitter()
		const off = wireUnsyncedTracking({ emitter, engine: null, initialCount: 0, record })
		for (let i = 0; i < 3; i++) emitter.emit({ type: 'operation:created', operation: {} as never })
		target.dispatchEvent(new Event('pagehide'))
		expect(calls.at(-1)).toEqual([3, true])
		off()
		target.dispatchEvent(new Event('pagehide'))
		expect(calls.at(-1)).toEqual([3, true])
	})

	test('with sync the count follows the engine and zero is exact', () => {
		const target = new EventTarget()
		vi.stubGlobal('window', target)
		const emitter = new SimpleEventEmitter()
		const engine = fakeEngine(0)
		const off = wireUnsyncedTracking({ emitter, engine, initialCount: 2, record })
		// The database held writes at open; the engine's queue is not loaded yet.
		expect(calls).toEqual([[2, false]])
		engine.set(2)
		engine.set(0)
		expect(calls.at(-1)).toEqual([0, true])
		emitter.emit({ type: 'operation:created', operation: {} as never })
		expect(calls.at(-1)).toEqual([1, false])
		// A positive count with sync is never claimed exact on hide.
		engine.set(4)
		target.dispatchEvent(new Event('pagehide'))
		expect(calls.at(-1)).toEqual([4, false])
		off()
	})

	test('an unchanged recording is not written again', () => {
		const emitter = new SimpleEventEmitter()
		const engine = fakeEngine(0)
		const off = wireUnsyncedTracking({ emitter, engine, initialCount: 0, record })
		engine.set(0)
		engine.set(0)
		expect(calls).toEqual([[0, true]])
		off()
	})

	test('a failing record is logged, never thrown', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const emitter = new SimpleEventEmitter()
		const off = wireUnsyncedTracking({
			emitter,
			engine: null,
			initialCount: 0,
			record: () => Promise.reject(new Error('manifest unavailable')),
		})
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(warn).toHaveBeenCalled()
		off()
		warn.mockRestore()
	})
})

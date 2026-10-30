import type { KoraEvent } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { describe, expect, test, vi } from 'vitest'
import { setupDevtools } from './setup-devtools'
import type { KoraConfig } from './types'

const harness = vi.hoisted(() => {
	const state: {
		release: () => void
		replayed: Array<{ event: { type: string }; receivedAt: number }>
		destroyed: number
		listenersAtReplay: number
	} = { release: () => {}, replayed: [], destroyed: 0, listenersAtReplay: -1 }
	const gate = new Promise<void>((resolve) => {
		state.release = resolve
	})
	return { state, gate }
})

// The DevTools chunk "arrives" only when the test releases the gate, so the window between
// createApp and the lazy load is controlled without any timers.
vi.mock('@korajs/devtools', async () => {
	await harness.gate
	class FakeInstrumenter {
		constructor(private readonly emitter: SimpleEventEmitter) {
			this.emitter.on('sync:connected', () => {})
		}
		replay(events: Array<{ event: { type: string }; receivedAt: number }>): void {
			harness.state.replayed.push(...events)
			harness.state.listenersAtReplay = this.emitter.listenerCount('sync:connected')
		}
		destroy(): void {
			harness.state.destroyed++
		}
	}
	return { Instrumenter: FakeInstrumenter }
})

const config = (devtools: boolean): KoraConfig => ({
	schema: { version: 1, collections: {}, relations: {}, migrations: [] },
	devtools,
})

const connected = (nodeId: string): KoraEvent => ({ type: 'sync:connected', nodeId })

describe('setupDevtools', () => {
	test('does nothing, and listens to nothing, when devtools is off', () => {
		const emitter = new SimpleEventEmitter()
		const setup = setupDevtools(config(false), emitter)
		expect(setup.destroy).toBeNull()
		emitter.emit(connected('a'))
		expect(harness.state.replayed).toHaveLength(0)
	})

	test('holds events until the lazily loaded instrumenter attaches, then replays them in order', async () => {
		const emitter = new SimpleEventEmitter()
		const setup = setupDevtools(config(true), emitter)

		// Emitted before the DevTools chunk has loaded: must reach the instrumenter later.
		emitter.emit(connected('first'))
		emitter.emit(connected('second'))
		expect(harness.state.replayed).toHaveLength(0)

		harness.state.release()
		await import('@korajs/devtools')
		// The instrumenter attaches in a continuation of the same import.
		await new Promise<void>((resolve) => queueMicrotask(resolve))

		expect(harness.state.replayed.map((entry) => entry.event)).toEqual([
			connected('first'),
			connected('second'),
		])
		// It had already attached its own listeners when the history was replayed.
		expect(harness.state.listenersAtReplay).toBe(1)

		// Handed over: the holding listener is gone, so later events are not held again.
		emitter.emit(connected('live'))
		expect(harness.state.replayed).toHaveLength(2)

		setup.destroy?.()
		expect(harness.state.destroyed).toBe(1)
	})
})

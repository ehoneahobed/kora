// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest'
import { EventBuffer } from '../buffer/event-buffer'
import type { Instrumenter } from '../instrumenter/instrumenter'
import * as panel from '../ui/panel'
import { mountKoraDevtoolsOverlay } from './embed-overlay'

function fakeInstrumenter(buffer: EventBuffer): Instrumenter {
	return { getBuffer: () => buffer } as unknown as Instrumenter
}

function toggle(): void {
	window.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', shiftKey: true, ctrlKey: true }))
}

function hints(): Element[] {
	return [...document.body.children].filter((el) => el.textContent?.includes('Kora DevTools'))
}

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	document.body.innerHTML = ''
})

describe('DevTools overlay', () => {
	test('an open overlay renders again only when new events arrive', () => {
		vi.useFakeTimers()
		const render = vi.spyOn(panel, 'renderDevtoolsPanel').mockImplementation(() => {})
		const buffer = new EventBuffer(100)
		const destroy = mountKoraDevtoolsOverlay(fakeInstrumenter(buffer))
		toggle()
		vi.advanceTimersByTime(3000)
		expect(render).toHaveBeenCalledTimes(1)

		buffer.push({ type: 'sync:connected', timestamp: 1 } as never)
		vi.advanceTimersByTime(300)
		expect(render).toHaveBeenCalledTimes(2)
		vi.advanceTimersByTime(3000)
		expect(render).toHaveBeenCalledTimes(2)
		destroy()
	})

	test('mounting twice leaves one hint, one key listener and one timer', () => {
		vi.useFakeTimers()
		const render = vi.spyOn(panel, 'renderDevtoolsPanel').mockImplementation(() => {})
		const buffer = new EventBuffer(100)
		mountKoraDevtoolsOverlay(fakeInstrumenter(buffer))
		const destroy = mountKoraDevtoolsOverlay(fakeInstrumenter(buffer))
		expect(hints()).toHaveLength(1)

		// One key listener: a toggle opens the overlay once (two listeners would open and close).
		toggle()
		expect(render).toHaveBeenCalledTimes(1)
		buffer.push({ type: 'sync:connected', timestamp: 1 } as never)
		vi.advanceTimersByTime(300)
		// One timer: the new event renders once, not once per mount.
		expect(render).toHaveBeenCalledTimes(2)
		destroy()
		expect(hints()).toHaveLength(0)
	})
})

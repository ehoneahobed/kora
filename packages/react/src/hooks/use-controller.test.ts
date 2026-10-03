import { act, cleanup, render } from '@testing-library/react'
import { StrictMode, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useController } from './use-controller'

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	cleanup()
	vi.useRealTimers()
})

function tracker() {
	const live = new Set<number>()
	let next = 0
	return {
		live,
		create: () => {
			const id = next++
			live.add(id)
			return { id }
		},
		destroy: (controller: { id: number }) => {
			live.delete(controller.id)
		},
	}
}

describe('useController', () => {
	it('StrictMode: a controller created by a discarded render is reaped, one stays live', () => {
		const t = tracker()
		const seen: number[] = []
		function Probe() {
			// Reading in render (as useRichText does for doc/text) creates lazily.
			const handle = useController(t.create, t.destroy, [])
			seen.push(handle.get().id)
			return null
		}
		const view = render(createElement(StrictMode, null, createElement(Probe)))
		act(() => {
			vi.advanceTimersByTime(1000)
		})
		expect(t.live.size).toBe(1)
		// The component renders the controller that stays live.
		expect(t.live.has(seen.at(-1) as number)).toBe(true)
		view.unmount()
		expect(t.live.size).toBe(0)
	})

	it('peek() never creates, and returns the committed controller', () => {
		const t = tracker()
		const peeks: Array<{ id: number } | null> = []
		function Probe() {
			const handle = useController(t.create, t.destroy, [])
			peeks.push(handle.peek())
			return null
		}
		const view = render(createElement(Probe))
		expect(peeks[0]).toBeNull()
		// The commit created it and re-rendered (version bump), so the next render sees it.
		expect(peeks.at(-1)).not.toBeNull()
		expect(t.live.size).toBe(1)
		view.unmount()
		expect(t.live.size).toBe(0)
	})

	it('replaces the controller when deps change and bumps the version', () => {
		const t = tracker()
		const versions: number[] = []
		function Probe({ dep }: { dep: string }) {
			const handle = useController(t.create, t.destroy, [dep])
			versions.push(handle.version)
			handle.get()
			return null
		}
		const view = render(createElement(Probe, { dep: 'a' }))
		const before = versions.at(-1) as number
		view.rerender(createElement(Probe, { dep: 'b' }))
		expect(versions.at(-1)).toBeGreaterThan(before)
		act(() => {
			vi.advanceTimersByTime(1000)
		})
		expect(t.live.size).toBe(1)
		view.unmount()
		expect(t.live.size).toBe(0)
	})
})

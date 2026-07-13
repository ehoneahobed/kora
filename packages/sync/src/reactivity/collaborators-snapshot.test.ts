import type { AwarenessManager } from '../awareness/awareness-manager'
import type { AwarenessState } from '../awareness/types'
import { describe, expect, it, vi } from 'vitest'
import {
	getRemoteAwarenessStates,
	subscribeRemoteAwarenessStates,
} from './collaborators-snapshot'

function createMockAwareness(
	states: Map<number, AwarenessState>,
	localClientId = 1,
): AwarenessManager {
	return {
		clientId: localClientId,
		getStates: () => states,
		on: vi.fn((_event: string, listener: () => void) => {
			listenerRef = listener
			return () => {}
		}),
	} as unknown as AwarenessManager
}

let listenerRef: (() => void) | undefined

describe('collaborators-snapshot', () => {
	it('getRemoteAwarenessStates excludes the local client', () => {
		const states = new Map<number, AwarenessState>([
			[1, { user: { name: 'Local', color: '#000' } }],
			[2, { user: { name: 'Remote', color: '#fff' } }],
		])
		const awareness = createMockAwareness(states, 1)

		expect(getRemoteAwarenessStates(awareness)).toEqual([
			{ user: { name: 'Remote', color: '#fff' } },
		])
	})

	it('subscribeRemoteAwarenessStates notifies only when remote set changes', () => {
		const states = new Map<number, AwarenessState>([
			[2, { user: { name: 'Remote', color: '#fff' } }],
		])
		const awareness = createMockAwareness(states, 1)
		const listener = vi.fn()

		subscribeRemoteAwarenessStates(awareness, listener)
		expect(listener).toHaveBeenCalledTimes(1)
		expect(listener.mock.calls[0]?.[0]).toEqual([
			{ user: { name: 'Remote', color: '#fff' } },
		])

		listener.mockClear()
		listenerRef?.()
		expect(listener).toHaveBeenCalledTimes(0)
	})
})

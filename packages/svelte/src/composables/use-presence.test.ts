import type { AwarenessState } from '@korajs/sync'
import { get } from 'svelte/store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCollaboratorsStore, useCollaborators } from './use-collaborators'
import { applyPresence, usePresence } from './use-presence'

interface MockAwareness {
	setLocalState: ReturnType<typeof vi.fn>
}

const state: {
	syncEngine: { getAwarenessManager: () => MockAwareness } | null
	app: { ready: Promise<void> } | null
	awareness: MockAwareness
} = {
	syncEngine: null,
	app: null,
	awareness: { setLocalState: vi.fn() },
}

let capturedCallback: ((states: AwarenessState[]) => void) | null = null
const unsubscribeSpy = vi.fn()

vi.mock('../context', () => ({
	// Live getters, like the provider's context: the engine arrives when the store opens.
	getKoraContext: () => ({
		get syncEngine() {
			return state.syncEngine
		},
		get app() {
			return state.app
		},
	}),
}))

vi.mock('@korajs/sync', () => ({
	subscribeRemoteAwarenessStates: (
		_awareness: unknown,
		callback: (states: AwarenessState[]) => void,
	) => {
		capturedCallback = callback
		return unsubscribeSpy
	},
}))

afterEach(() => {
	state.syncEngine = null
	state.app = null
	state.awareness = { setLocalState: vi.fn() }
	capturedCallback = null
	unsubscribeSpy.mockClear()
})

describe('applyPresence', () => {
	it('is a no-op returning a cleanup when there is no sync engine', () => {
		const cleanup = applyPresence({ name: 'Ada', color: '#f00' })
		expect(cleanup).toBeTypeOf('function')
		// Should not throw.
		cleanup()
	})

	it('is a no-op when the user is null', () => {
		state.syncEngine = { getAwarenessManager: () => state.awareness }
		const cleanup = applyPresence(null)
		cleanup()
		expect(state.awareness.setLocalState).not.toHaveBeenCalled()
	})

	it('publishes local presence and clears it on cleanup', () => {
		state.syncEngine = { getAwarenessManager: () => state.awareness }
		const cleanup = applyPresence({ name: 'Ada', color: '#ff0000', avatar: 'a.png' })

		expect(state.awareness.setLocalState).toHaveBeenCalledWith({
			user: { name: 'Ada', color: '#ff0000', avatar: 'a.png' },
		})

		cleanup()
		expect(state.awareness.setLocalState).toHaveBeenLastCalledWith(null)
	})

	it('is aliased as usePresence', () => {
		expect(usePresence).toBe(applyPresence)
	})
})

describe('createCollaboratorsStore', () => {
	it('returns an empty list when there is no sync engine', () => {
		const store = createCollaboratorsStore()
		expect(get(store)).toEqual([])
	})

	it('is aliased as useCollaborators', () => {
		expect(useCollaborators).toBe(createCollaboratorsStore)
	})

	it('reflects remote awareness states and unsubscribes on stop', () => {
		state.syncEngine = { getAwarenessManager: () => state.awareness }
		const store = createCollaboratorsStore()

		const seen: AwarenessState[][] = []
		const stop = store.subscribe((states) => seen.push(states))

		const remote = [{ user: { name: 'Bob', color: '#00f' } }] as unknown as AwarenessState[]
		capturedCallback?.(remote)
		expect(get(store)).toEqual(remote)

		stop()
		expect(unsubscribeSpy).toHaveBeenCalled()
	})

	it('follows the sync engine that arrives when the store opens', async () => {
		let open = (): void => {}
		state.app = {
			ready: new Promise<void>((resolve) => {
				open = resolve
			}),
		}
		const store = createCollaboratorsStore()
		const stop = store.subscribe(() => {})
		expect(capturedCallback).toBeNull()

		state.syncEngine = { getAwarenessManager: () => state.awareness }
		open()
		await state.app.ready

		const remote = [{ user: { name: 'Bob', color: '#00f' } }] as unknown as AwarenessState[]
		capturedCallback?.(remote)
		expect(get(store)).toEqual(remote)

		stop()
		expect(unsubscribeSpy).toHaveBeenCalled()
	})
})

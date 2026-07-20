import type { AwarenessState } from '@korajs/sync'
import type { SyncEngine } from '@korajs/sync'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, shallowRef } from 'vue'
import { koraContextKey } from '../context'
import type { KoraContextValue } from '../types'
import { useCollaborators, usePresence } from './use-presence'

let capturedCallback: ((states: AwarenessState[]) => void) | null = null
const unsubscribeSpy = vi.fn()

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
	capturedCallback = null
	unsubscribeSpy.mockClear()
	vi.restoreAllMocks()
})

function makeContext(
	syncEngine: SyncEngine | null,
): ReturnType<typeof shallowRef<KoraContextValue>> {
	return shallowRef<KoraContextValue | null>({
		store: {} as KoraContextValue['store'],
		syncEngine,
		app: null,
		events: null,
		subscribeSyncStatus: null,
		queryStoreCache: {} as KoraContextValue['queryStoreCache'],
	}) as ReturnType<typeof shallowRef<KoraContextValue>>
}

describe('usePresence', () => {
	it('publishes local presence on mount and clears it on unmount', () => {
		const setLocalState = vi.fn()
		const syncEngine = {
			getAwarenessManager: () => ({ setLocalState }),
		} as unknown as SyncEngine
		const contextRef = makeContext(syncEngine)

		const wrapper = mount(
			defineComponent({
				setup() {
					usePresence({ name: 'Ada', color: '#ff0000' })
					return () => h('div')
				},
			}),
			{ global: { provide: { [koraContextKey]: contextRef } } },
		)

		expect(setLocalState).toHaveBeenCalledWith({
			user: { name: 'Ada', color: '#ff0000', avatar: undefined },
		})

		wrapper.unmount()
		expect(setLocalState).toHaveBeenLastCalledWith(null)
	})

	it('does nothing when there is no sync engine', () => {
		const contextRef = makeContext(null)
		expect(() =>
			mount(
				defineComponent({
					setup() {
						usePresence({ name: 'Ada', color: '#ff0000' })
						return () => h('div')
					},
				}),
				{ global: { provide: { [koraContextKey]: contextRef } } },
			),
		).not.toThrow()
	})
})

describe('useCollaborators', () => {
	it('exposes remote awareness states reactively and unsubscribes on unmount', async () => {
		const syncEngine = {
			getAwarenessManager: () => ({}),
		} as unknown as SyncEngine
		const contextRef = makeContext(syncEngine)

		const wrapper = mount(
			defineComponent({
				setup() {
					const collaborators = useCollaborators()
					return () =>
						h(
							'span',
							{ 'data-testid': 'names' },
							collaborators.value.map((c) => c.user?.name).join(','),
						)
				},
			}),
			{ global: { provide: { [koraContextKey]: contextRef } } },
		)

		expect(wrapper.get('[data-testid="names"]').text()).toBe('')

		capturedCallback?.([{ user: { name: 'Bob', color: '#00f' } }] as unknown as AwarenessState[])
		await wrapper.vm.$nextTick()
		expect(wrapper.get('[data-testid="names"]').text()).toBe('Bob')

		wrapper.unmount()
		expect(unsubscribeSpy).toHaveBeenCalled()
	})

	it('returns an empty list when there is no sync engine', () => {
		const contextRef = makeContext(null)
		const wrapper = mount(
			defineComponent({
				setup() {
					const collaborators = useCollaborators()
					return () => h('span', { 'data-testid': 'len' }, String(collaborators.value.length))
				},
			}),
			{ global: { provide: { [koraContextKey]: contextRef } } },
		)
		expect(wrapper.get('[data-testid="len"]').text()).toBe('0')
	})
})

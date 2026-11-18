import type { AwarenessState } from '@korajs/sync'
import type { SyncEngine } from '@korajs/sync'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref, shallowRef } from 'vue'
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

describe('usePresence follows a user that changes', () => {
	for (const kind of ['ref', 'getter'] as const) {
		it(`updates local awareness when a ${kind} user changes`, async () => {
			const setLocalState = vi.fn()
			const syncEngine = { getAwarenessManager: () => ({ setLocalState }) } as unknown as SyncEngine
			const user = ref<{ name: string; color: string } | null>({ name: 'Ada', color: '#f00' })
			mount(
				defineComponent({
					setup() {
						usePresence(kind === 'ref' ? user : () => user.value)
						return () => h('div')
					},
				}),
				{ global: { provide: { [koraContextKey]: makeContext(syncEngine) } } },
			)
			expect(setLocalState).toHaveBeenLastCalledWith({
				user: { name: 'Ada', color: '#f00', avatar: undefined },
			})
			user.value = { name: 'Grace', color: '#00f' }
			await nextTick()
			expect(setLocalState).toHaveBeenLastCalledWith({
				user: { name: 'Grace', color: '#00f', avatar: undefined },
			})
			user.value = null
			await nextTick()
			expect(setLocalState).toHaveBeenLastCalledWith(null)
		})
	}
})

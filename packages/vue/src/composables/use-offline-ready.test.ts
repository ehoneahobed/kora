import { OFFLINE_STATUS_UNKNOWN, type OfflineStatus } from '@korajs/core/bindings'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defineComponent, h, shallowRef } from 'vue'
import { koraContextKey } from '../context'
import type { KoraContextValue } from '../types'
import { useOfflineReady } from './use-offline-ready'

function mountWithApp(offline: unknown) {
	const contextRef = shallowRef<KoraContextValue | null>({
		store: {} as KoraContextValue['store'],
		syncEngine: null,
		app: offline === undefined ? null : ({ offline } as unknown as KoraContextValue['app']),
		events: null,
		subscribeSyncStatus: null,
		queryStoreCache: {} as KoraContextValue['queryStoreCache'],
	})
	const Comp = defineComponent({
		setup() {
			const status = useOfflineReady()
			return () =>
				h(
					'span',
					{ 'data-testid': 'state' },
					`${status.value.state}:${status.value.reasons.join(',')}`,
				)
		},
	})
	return mount(Comp, { global: { provide: { [koraContextKey]: contextRef } } })
}

describe('useOfflineReady', () => {
	it('is not ready without app.offline', () => {
		const wrapper = mountWithApp(undefined)
		expect(wrapper.get('[data-testid="state"]').text()).toMatch(/^not-ready:/)
	})

	it('follows app.offline and unsubscribes when the scope ends', async () => {
		let current: OfflineStatus = {
			...OFFLINE_STATUS_UNKNOWN,
			state: 'preparing',
			reasons: ['data-syncing'],
		}
		const listeners = new Set<(next: OfflineStatus) => void>()
		const wrapper = mountWithApp({
			status: () => current,
			subscribe: (listener: (next: OfflineStatus) => void) => {
				listeners.add(listener)
				return () => listeners.delete(listener)
			},
		})
		expect(wrapper.get('[data-testid="state"]').text()).toBe('preparing:data-syncing')

		current = { ...OFFLINE_STATUS_UNKNOWN, state: 'ready', reasons: [] }
		for (const listener of listeners) listener(current)
		await wrapper.vm.$nextTick()
		expect(wrapper.get('[data-testid="state"]').text()).toBe('ready:')

		wrapper.unmount()
		expect(listeners.size).toBe(0)
	})
})

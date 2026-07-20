import type { KoraEventEmitter } from '@korajs/core'
import type { SyncEngine, SyncStatusInfo } from '@korajs/sync'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, shallowRef } from 'vue'
import { koraContextKey } from '../context'
import type { KoraContextValue } from '../types'
import { useSyncStatus } from './use-sync-status'

afterEach(() => {
	vi.restoreAllMocks()
})

function makeStatus(overrides: Partial<SyncStatusInfo> = {}): SyncStatusInfo {
	return {
		status: 'offline',
		pendingOperations: 0,
		lastSyncedAt: null,
		lastSuccessfulPush: null,
		lastSuccessfulPull: null,
		conflicts: 0,
		clockSkewMs: null,
		...overrides,
	}
}

function createMockEmitter(): KoraEventEmitter & { emitSyncEvent: () => void } {
	const handlers = new Map<string, Set<(event: unknown) => void>>()
	return {
		on(type: string, handler: (event: unknown) => void) {
			if (!handlers.has(type)) handlers.set(type, new Set())
			handlers.get(type)?.add(handler)
			return () => {
				handlers.get(type)?.delete(handler)
			}
		},
		emitSyncEvent() {
			for (const handler of handlers.get('sync:sent') ?? []) {
				handler({ type: 'sync:sent' })
			}
		},
	} as KoraEventEmitter & { emitSyncEvent: () => void }
}

function mountWithContext(context: Partial<KoraContextValue>) {
	const contextRef = shallowRef<KoraContextValue | null>({
		store: {} as KoraContextValue['store'],
		syncEngine: null,
		app: null,
		events: null,
		subscribeSyncStatus: null,
		queryStoreCache: {} as KoraContextValue['queryStoreCache'],
		...context,
	})

	const Comp = defineComponent({
		setup() {
			const status = useSyncStatus()
			return () =>
				h('div', null, [
					h('span', { 'data-testid': 'status' }, status.value.status),
					h('span', { 'data-testid': 'pending' }, String(status.value.pendingOperations)),
				])
		},
	})

	return mount(Comp, { global: { provide: { [koraContextKey]: contextRef } } })
}

describe('useSyncStatus', () => {
	it('returns offline when no sync engine is configured', () => {
		const wrapper = mountWithContext({})
		expect(wrapper.get('[data-testid="status"]').text()).toBe('offline')
	})

	it('returns the engine status when a sync engine is present', () => {
		const syncEngine = {
			getStatus: () => makeStatus({ status: 'synced', pendingOperations: 3 }),
		} as unknown as SyncEngine
		const wrapper = mountWithContext({ syncEngine })
		expect(wrapper.get('[data-testid="status"]').text()).toBe('synced')
		expect(wrapper.get('[data-testid="pending"]').text()).toBe('3')
	})

	it('re-renders reactively when a sync event fires', async () => {
		let current = makeStatus({ status: 'offline' })
		const syncEngine = { getStatus: () => current } as unknown as SyncEngine
		const events = createMockEmitter()

		const wrapper = mountWithContext({ syncEngine, events })
		expect(wrapper.get('[data-testid="status"]').text()).toBe('offline')

		current = makeStatus({ status: 'syncing', pendingOperations: 5 })
		events.emitSyncEvent()
		await wrapper.vm.$nextTick()

		expect(wrapper.get('[data-testid="status"]').text()).toBe('syncing')
		expect(wrapper.get('[data-testid="pending"]').text()).toBe('5')
	})

	it('reflects updates pushed via a status bridge', async () => {
		let push: (status: SyncStatusInfo) => void = () => {}
		const subscribeSyncStatus = (listener: (status: SyncStatusInfo) => void): (() => void) => {
			push = listener
			listener(makeStatus({ status: 'connected' }))
			return () => {}
		}

		const wrapper = mountWithContext({ subscribeSyncStatus })
		expect(wrapper.get('[data-testid="status"]').text()).toBe('connected')

		push(makeStatus({ status: 'synced', pendingOperations: 1 }))
		await wrapper.vm.$nextTick()
		expect(wrapper.get('[data-testid="status"]').text()).toBe('synced')
	})

	it('unsubscribes from the status bridge on unmount', () => {
		const unsubscribe = vi.fn()
		const subscribeSyncStatus = (listener: (status: SyncStatusInfo) => void): (() => void) => {
			listener(makeStatus())
			return unsubscribe
		}

		const wrapper = mountWithContext({ subscribeSyncStatus })
		wrapper.unmount()
		expect(unsubscribe).toHaveBeenCalled()
	})
})

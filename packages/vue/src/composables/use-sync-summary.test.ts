import type { SyncStatusInfo } from '@korajs/sync'
import { summarizeSyncStatus } from '@korajs/sync/lite'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defineComponent, h, shallowRef } from 'vue'
import { koraContextKey } from '../context'
import type { KoraContextValue } from '../types'
import { useSyncSummary } from './use-sync-summary'

function makeStatus(overrides: Partial<SyncStatusInfo> = {}): SyncStatusInfo {
	return {
		status: 'offline',
		reconnecting: false,
		pendingOperations: 0,
		lastSyncedAt: null,
		lastSuccessfulPush: null,
		lastSuccessfulPull: null,
		conflicts: 0,
		clockSkewMs: null,
		...overrides,
	}
}

function mountWith(context: Partial<KoraContextValue>) {
	const contextRef = shallowRef<KoraContextValue | null>({
		store: {} as KoraContextValue['store'],
		syncEngine: null,
		app: null,
		events: null,
		subscribeSyncStatus: null,
		queryStoreCache: {} as KoraContextValue['queryStoreCache'],
		...context,
	})
	let summary: ReturnType<typeof useSyncSummary> | null = null
	const Comp = defineComponent({
		setup() {
			summary = useSyncSummary()
			return () => h('span', { 'data-testid': 'title' }, summary?.value.title)
		},
	})
	const wrapper = mount(Comp, { global: { provide: { [koraContextKey]: contextRef } } })
	return { wrapper, summary: () => summary?.value }
}

describe('useSyncSummary (Vue)', () => {
	it('summarizes the live status and updates with it', async () => {
		let push: (status: SyncStatusInfo) => void = () => {}
		const subscribeSyncStatus = (listener: (status: SyncStatusInfo) => void): (() => void) => {
			push = listener
			listener(makeStatus({ status: 'connected' }))
			return () => {}
		}
		const { wrapper, summary } = mountWith({ subscribeSyncStatus })
		expect(summary()).toEqual(
			summarizeSyncStatus(makeStatus({ status: 'connected' }), { syncConfigured: true }),
		)
		const next = makeStatus({ status: 'syncing', pendingOperations: 4 })
		push(next)
		await wrapper.vm.$nextTick()
		expect(summary()).toEqual(summarizeSyncStatus(next, { syncConfigured: true }))
		expect(wrapper.get('[data-testid="title"]').text()).toBe(
			summarizeSyncStatus(next, { syncConfigured: true }).title,
		)
	})

	it('says sync is not configured when there is no engine or bridge', () => {
		const { summary } = mountWith({})
		expect(summary()).toEqual(summarizeSyncStatus(makeStatus(), { syncConfigured: false }))
	})
})

import type {
	CollectionRecord,
	QueryBuilder,
	QueryStoreCache,
	SubscriptionCallback,
} from '@korajs/store'
import { QueryStoreCache as QueryStoreCacheClass } from '@korajs/store'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h, shallowRef } from 'vue'
import { koraContextKey } from '../context'
import type { KoraContextValue } from '../types'
import { useQuery } from './use-query'

function createTestContext(): {
	contextRef: ReturnType<typeof shallowRef<KoraContextValue | null>>
	queryStoreCache: QueryStoreCache
} {
	const queryStoreCache = new QueryStoreCacheClass()
	const contextRef = shallowRef<KoraContextValue | null>({
		store: {} as KoraContextValue['store'],
		syncEngine: null,
		app: null,
		events: null,
		subscribeSyncStatus: null,
		queryStoreCache,
	})
	return { contextRef, queryStoreCache }
}

function createMockQueryBuilder(
	initialResults: CollectionRecord[] = [],
	descriptor: Record<string, unknown> = { collection: 'todos', where: {}, orderBy: [] },
): {
	queryBuilder: QueryBuilder
	triggerCallback: (results: CollectionRecord[]) => void
} {
	let capturedCallback: SubscriptionCallback<CollectionRecord> | null = null

	const queryBuilder = {
		subscribe: vi.fn((callback: SubscriptionCallback<CollectionRecord>) => {
			capturedCallback = callback
			callback(initialResults)
			return vi.fn()
		}),
		getDescriptor: vi.fn().mockReturnValue(descriptor),
	} as unknown as QueryBuilder

	return {
		queryBuilder,
		triggerCallback: (results) => {
			capturedCallback?.(results)
		},
	}
}

function createRecord(id: string): CollectionRecord {
	return { id, createdAt: 1000, updatedAt: 1000 }
}

describe('useQuery', () => {
	it('returns reactive query results', async () => {
		const records = [createRecord('1'), createRecord('2')]
		const { queryBuilder } = createMockQueryBuilder(records)
		const { contextRef } = createTestContext()

		const Comp = defineComponent({
			setup() {
				const results = useQuery(queryBuilder)
				return () =>
					h('div', { 'data-testid': 'results' }, JSON.stringify(results.value.map((r) => r.id)))
			},
		})

		const wrapper = mount(Comp, {
			global: {
				provide: {
					[koraContextKey]: contextRef,
				},
			},
		})

		expect(wrapper.get('[data-testid="results"]').text()).toBe('["1","2"]')
	})

	it('updates when subscription emits new data', async () => {
		const { queryBuilder, triggerCallback } = createMockQueryBuilder([createRecord('1')])
		const { contextRef } = createTestContext()

		const Comp = defineComponent({
			setup() {
				const results = useQuery(queryBuilder)
				return () =>
					h('div', { 'data-testid': 'results' }, JSON.stringify(results.value.map((r) => r.id)))
			},
		})

		const wrapper = mount(Comp, {
			global: {
				provide: {
					[koraContextKey]: contextRef,
				},
			},
		})

		triggerCallback([createRecord('1'), createRecord('2')])
		await wrapper.vm.$nextTick()
		expect(wrapper.get('[data-testid="results"]').text()).toBe('["1","2"]')
	})

	it('releases the query from the cache on unmount', () => {
		const { queryBuilder } = createMockQueryBuilder([createRecord('1')])
		const { contextRef, queryStoreCache } = createTestContext()
		const releaseSpy = vi.spyOn(queryStoreCache, 'release')

		const Comp = defineComponent({
			setup() {
				useQuery(queryBuilder)
				return () => h('div')
			},
		})

		const wrapper = mount(Comp, {
			global: { provide: { [koraContextKey]: contextRef } },
		})

		wrapper.unmount()
		expect(releaseSpy).toHaveBeenCalledWith(queryBuilder)
	})

	it('returns an empty result and does not subscribe when disabled', () => {
		const { queryBuilder } = createMockQueryBuilder([createRecord('1')])
		const { contextRef } = createTestContext()

		const Comp = defineComponent({
			setup() {
				const results = useQuery(queryBuilder, { enabled: false })
				return () => h('div', { 'data-testid': 'results' }, JSON.stringify(results.value))
			},
		})

		const wrapper = mount(Comp, {
			global: { provide: { [koraContextKey]: contextRef } },
		})

		expect(wrapper.get('[data-testid="results"]').text()).toBe('[]')
		expect(queryBuilder.subscribe).not.toHaveBeenCalled()
	})

	it('re-subscribes and releases the previous store when the query descriptor changes', async () => {
		// useQuery watches `query.getDescriptor()`; when a builder reports a new
		// descriptor (reactively), the composable must release the old store and
		// subscribe to the new one.
		const descriptor = shallowRef<Record<string, unknown>>({
			collection: 'todos',
			where: { done: false },
			orderBy: [],
		})
		const subscribe = vi.fn((callback: (results: CollectionRecord[]) => void) => {
			callback([
				createRecord(
					String(
						descriptor.value.where && (descriptor.value.where as Record<string, unknown>).done
							? 2
							: 1,
					),
				),
			])
			return vi.fn()
		})
		const queryBuilder = {
			subscribe,
			getDescriptor: () => descriptor.value,
		} as unknown as QueryBuilder

		const { contextRef, queryStoreCache } = createTestContext()
		const releaseSpy = vi.spyOn(queryStoreCache, 'release')

		const Comp = defineComponent({
			setup() {
				const results = useQuery(queryBuilder)
				return () =>
					h('div', { 'data-testid': 'results' }, JSON.stringify(results.value.map((r) => r.id)))
			},
		})

		const wrapper = mount(Comp, {
			global: { provide: { [koraContextKey]: contextRef } },
		})

		expect(wrapper.get('[data-testid="results"]').text()).toBe('["1"]')
		const initialSubscribeCalls = subscribe.mock.calls.length

		descriptor.value = { collection: 'todos', where: { done: true }, orderBy: [] }
		await wrapper.vm.$nextTick()

		expect(subscribe.mock.calls.length).toBeGreaterThan(initialSubscribeCalls)
		expect(releaseSpy).toHaveBeenCalled()
		expect(wrapper.get('[data-testid="results"]').text()).toBe('["2"]')
	})
})

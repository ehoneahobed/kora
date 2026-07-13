import type { SyncEngine, SyncStatusInfo } from '@korajs/sync'
import { QueryStoreCache } from '@korajs/store'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KoraProvider } from '../../src/components/kora-provider'
import { useCollection } from '../../src/composables/use-collection'
import { useMutation } from '../../src/composables/use-mutation'
import { useQuery } from '../../src/composables/use-query'
import { useSyncStatus } from '../../src/composables/use-sync-status'
import type { KoraAppLike } from '../../src/types'
import { createTestStore, tick } from '../fixtures/test-helpers'

afterEach(() => {
	vi.restoreAllMocks()
})

describe('Integration: full flow', () => {
	it('useQuery reactively updates when store data changes', async () => {
		const store = await createTestStore()

		const TodoList = defineComponent({
			setup() {
				const todos = useQuery(store.collection('todos').where({}))
				return () => h('div', { 'data-testid': 'count' }, String(todos.value.length))
			},
		})

		const app = mount(
			defineComponent({
				setup() {
					return () => h(KoraProvider, { store }, () => h(TodoList))
				},
			}),
		)

		expect(app.get('[data-testid="count"]').text()).toBe('0')

		await store.collection('todos').insert({ title: 'Test todo' })
		await tick()
		await app.vm.$nextTick()

		expect(app.get('[data-testid="count"]').text()).toBe('1')
		app.unmount()
		await store.close()
	})

	it('useMutation + useQuery: mutate and see results', async () => {
		const store = await createTestStore()

		const TodoApp = defineComponent({
			setup() {
				const todos = useQuery(store.collection('todos').where({}))
				const { mutate } = useMutation((title: string) =>
					store.collection('todos').insert({ title }),
				)
				return () =>
					h('div', null, [
						h('div', { 'data-testid': 'count' }, String(todos.value.length)),
						h(
							'button',
							{
								type: 'button',
								'data-testid': 'add',
								onClick: () => mutate('New todo'),
							},
							'Add',
						),
					])
			},
		})

		const wrapper = mount(defineComponent({
			setup: () => () => h(KoraProvider, { store }, () => h(TodoApp)),
		}))

		expect(wrapper.get('[data-testid="count"]').text()).toBe('0')
		await wrapper.get('[data-testid="add"]').trigger('click')
		await tick(50)
		await wrapper.vm.$nextTick()

		expect(wrapper.get('[data-testid="count"]').text()).toBe('1')
		await store.close()
	})

	it('useSyncStatus shows offline without sync engine', async () => {
		const store = await createTestStore()

		const StatusDisplay = defineComponent({
			setup() {
				const status = useSyncStatus()
				return () => h('span', { 'data-testid': 'status' }, status.value.status)
			},
		})

		const wrapper = mount(defineComponent({
			setup: () => () => h(KoraProvider, { store }, () => h(StatusDisplay)),
		}))

		expect(wrapper.get('[data-testid="status"]').text()).toBe('offline')
		await store.close()
	})

	it('multiple hooks in one component work together', async () => {
		const store = await createTestStore()
		const syncEngine = {
			getStatus: vi.fn().mockReturnValue({
				status: 'synced',
				pendingOperations: 0,
				lastSyncedAt: 99999,
			} as SyncStatusInfo),
		} as unknown as SyncEngine

		const FullApp = defineComponent({
			setup() {
				const todos = useQuery(store.collection('todos').where({}))
				const { mutate } = useMutation((title: string) =>
					store.collection('todos').insert({ title }),
				)
				const status = useSyncStatus()
				const todosCollection = useCollection('todos')

				return () =>
					h('div', null, [
						h('div', { 'data-testid': 'count' }, String(todos.value.length)),
						h('div', { 'data-testid': 'status' }, status.value.status),
						h('div', { 'data-testid': 'has-collection' }, todosCollection ? 'yes' : 'no'),
						h(
							'button',
							{
								type: 'button',
								'data-testid': 'add',
								onClick: () => mutate('Todo'),
							},
							'Add',
						),
					])
			},
		})

		const wrapper = mount(defineComponent({
			setup: () => () => h(KoraProvider, { store, syncEngine }, () => h(FullApp)),
		}))

		expect(wrapper.get('[data-testid="count"]').text()).toBe('0')
		expect(wrapper.get('[data-testid="status"]').text()).toBe('synced')
		expect(wrapper.get('[data-testid="has-collection"]').text()).toBe('yes')

		await wrapper.get('[data-testid="add"]').trigger('click')
		await tick(50)
		await wrapper.vm.$nextTick()

		expect(wrapper.get('[data-testid="count"]').text()).toBe('1')
		await store.close()
	})
})

describe('Integration: app prop', () => {
	it('KoraProvider with app prop waits for ready then renders', async () => {
		const store = await createTestStore()
		let resolveReady!: () => void
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve
		})

		const app: KoraAppLike = {
			ready,
			getStore: () => store,
			getSyncEngine: () => null,
			getQueryStoreCache: () => new QueryStoreCache(),
		}

		const TodoList = defineComponent({
			setup() {
				const todos = useQuery(store.collection('todos').where({}))
				return () => h('div', { 'data-testid': 'count' }, String(todos.value.length))
			},
		})

		const wrapper = mount(defineComponent({
			setup: () => () => h(KoraProvider, { app }, () => h(TodoList)),
		}))

		expect(wrapper.find('[data-testid="count"]').exists()).toBe(false)

		resolveReady()
		await ready
		await wrapper.vm.$nextTick()

		expect(wrapper.get('[data-testid="count"]').text()).toBe('0')

		await store.collection('todos').insert({ title: 'App prop test' })
		await tick()
		await wrapper.vm.$nextTick()

		expect(wrapper.get('[data-testid="count"]').text()).toBe('1')
		await store.close()
	})

	it('KoraProvider with app prop shows fallback then children', async () => {
		const store = await createTestStore()
		let resolveReady!: () => void
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve
		})

		const app: KoraAppLike = {
			ready,
			getStore: () => store,
			getSyncEngine: () => null,
			getQueryStoreCache: () => new QueryStoreCache(),
		}

		const wrapper = mount(defineComponent({
			setup: () => () =>
				h(
					KoraProvider,
					{ app, fallback: h('div', { 'data-testid': 'fallback' }, 'Loading...') },
					() => h('div', { 'data-testid': 'child' }, 'Loaded!'),
				),
		}))

		expect(wrapper.get('[data-testid="fallback"]').text()).toBe('Loading...')
		expect(wrapper.find('[data-testid="child"]').exists()).toBe(false)

		resolveReady()
		await ready
		await wrapper.vm.$nextTick()

		expect(wrapper.get('[data-testid="child"]').text()).toBe('Loaded!')
		expect(wrapper.find('[data-testid="fallback"]').exists()).toBe(false)
		await store.close()
	})
})

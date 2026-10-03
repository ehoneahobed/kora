import type { CollectionRecord, QueryBuilder, QueryStore } from '@korajs/store'
import { QueryStoreCache } from '@korajs/store'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref, shallowRef } from 'vue'
import { koraContextKey } from '../context'
import type { KoraContextValue } from '../types'
import { useQuery, useQueryState } from './use-query'

afterEach(() => {
	vi.restoreAllMocks()
})

interface Fake {
	query: QueryBuilder
	emit(rows: CollectionRecord[]): void
	fail(error: Error): void
	unsubscribed: () => number
}

function fakeQuery(key: string, rows: CollectionRecord[]): Fake {
	let cb: ((rows: CollectionRecord[]) => void) | null = null
	let onError: ((error: Error) => void) | null = null
	let unsubscribes = 0
	return {
		query: {
			getDescriptor: () => ({ collection: 'todos', where: { key }, orderBy: [] }),
			subscribe: (callback: (rows: CollectionRecord[]) => void, errorCb?: (e: Error) => void) => {
				cb = callback
				onError = errorCb ?? null
				callback(rows)
				return () => {
					unsubscribes++
				}
			},
		} as unknown as QueryBuilder,
		emit: (next) => cb?.(next),
		fail: (error) => onError?.(error),
		unsubscribed: () => unsubscribes,
	}
}

const rec = (id: string): CollectionRecord => ({ id, createdAt: 1, updatedAt: 1 })

/** A QueryStore with the STORE-12 error channel, as the store package exposes it. */
class ErrorChannelCache extends QueryStoreCache {
	override getOrCreate<T>(query: QueryBuilder<T>): QueryStore<T> {
		let rows: readonly T[] = []
		let loaded = false
		let error: Error | null = null
		const listeners = new Set<() => void>()
		const notify = () => {
			for (const l of listeners) l()
		}
		const subscribe = query.subscribe as unknown as (
			cb: (rows: T[]) => void,
			onError: (e: Error) => void,
		) => () => void
		let started = false
		return {
			subscribe: (listener: () => void) => {
				listeners.add(listener)
				if (!started) {
					started = true
					subscribe(
						(next) => {
							loaded = true
							error = null
							rows = Object.freeze([...next])
							notify()
						},
						(failure) => {
							error = failure
							notify()
						},
					)
				}
				return () => listeners.delete(listener)
			},
			getSnapshot: () => rows,
			hasSnapshot: () => loaded,
			getError: () => error,
		} as unknown as QueryStore<T>
	}
	override release(): void {}
}

function context(cache: QueryStoreCache = new QueryStoreCache()) {
	return shallowRef<KoraContextValue | null>({
		store: {} as KoraContextValue['store'],
		syncEngine: null,
		app: null,
		events: null,
		subscribeSyncStatus: null,
		queryStoreCache: cache,
	})
}

describe('Vue useQuery reactive inputs (DX-7)', () => {
	it('follows a ref of the query and releases the previous subscription', async () => {
		const open = fakeQuery('open', [rec('o')])
		const done = fakeQuery('done', [rec('d')])
		const current = shallowRef<QueryBuilder>(open.query)
		const Comp = defineComponent({
			setup() {
				const rows = useQuery(current)
				return () => h('div', rows.value.map((r) => r.id).join(','))
			},
		})
		const wrapper = mount(Comp, { global: { provide: { [koraContextKey]: context() } } })
		expect(wrapper.text()).toBe('o')
		current.value = done.query
		await nextTick()
		expect(wrapper.text()).toBe('d')
		expect(open.unsubscribed()).toBe(1)
		wrapper.unmount()
		expect(done.unsubscribed()).toBe(1)
	})

	it('accepts enabled as a ref', async () => {
		const fake = fakeQuery('enabled', [rec('a')])
		const enabled = ref(false)
		const Comp = defineComponent({
			setup() {
				const rows = useQuery(fake.query, { enabled })
				return () => h('div', `n:${rows.value.length}`)
			},
		})
		const wrapper = mount(Comp, { global: { provide: { [koraContextKey]: context() } } })
		expect(wrapper.text()).toBe('n:0')
		enabled.value = true
		await nextTick()
		expect(wrapper.text()).toBe('n:1')
		enabled.value = false
		await nextTick()
		expect(wrapper.text()).toBe('n:0')
	})

	it('a getter returning null disables the query', async () => {
		const fake = fakeQuery('nullable', [rec('a')])
		const show = ref(false)
		const Comp = defineComponent({
			setup() {
				const rows = useQuery(() => (show.value ? fake.query : null))
				return () => h('div', `n:${rows.value.length}`)
			},
		})
		const wrapper = mount(Comp, { global: { provide: { [koraContextKey]: context() } } })
		expect(wrapper.text()).toBe('n:0')
		show.value = true
		await nextTick()
		expect(wrapper.text()).toBe('n:1')
	})
})

describe('Vue query error state (STORE-12 consumer)', () => {
	it('useQueryState exposes the error and clears it on the next result', async () => {
		const fake = fakeQuery('err', [rec('a')])
		const captured: { state: ReturnType<typeof useQueryState> | null } = { state: null }
		const Comp = defineComponent({
			setup() {
				const state = useQueryState(fake.query)
				captured.state = state
				return () => h('div', state.error.value?.message ?? 'ok')
			},
		})
		const wrapper = mount(Comp, {
			global: { provide: { [koraContextKey]: context(new ErrorChannelCache()) } },
		})
		expect(captured.state?.ready.value).toBe(true)
		fake.fail(new Error('boom'))
		await nextTick()
		expect(wrapper.text()).toBe('boom')
		expect(captured.state?.data.value).toHaveLength(1)
		fake.emit([rec('a'), rec('b')])
		await nextTick()
		expect(wrapper.text()).toBe('ok')
		expect(captured.state?.data.value).toHaveLength(2)
	})

	it('useQuery reports a failure to onError, or console.error without one', async () => {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
		const fake = fakeQuery('report', [rec('a')])
		const unhandled = fakeQuery('report-unhandled', [rec('a')])
		const onError = vi.fn()
		const Comp = defineComponent({
			setup() {
				useQuery(fake.query, { onError })
				useQuery(unhandled.query)
				return () => h('div')
			},
		})
		mount(Comp, { global: { provide: { [koraContextKey]: context(new ErrorChannelCache()) } } })
		fake.fail(new Error('bad field'))
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'bad field' }))
		expect(errors).not.toHaveBeenCalled()
		unhandled.fail(new Error('bad field'))
		expect(errors).toHaveBeenCalledTimes(1)
	})
})

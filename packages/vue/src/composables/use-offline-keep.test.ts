import type { OfflineKeepOptions, OfflineKeepQuery } from '@korajs/core/bindings'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, shallowRef } from 'vue'
import { koraContextKey } from '../context'
import type { KoraContextValue } from '../types'
import { useOfflineKeep } from './use-offline-keep'

const query = (where: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
	({ getDescriptor: () => ({ collection: 'lessons', where, ...extra }) }) as OfflineKeepQuery

function fakeOffline(refuse?: Error) {
	const holds: Array<{ where: unknown; released: boolean }> = []
	return {
		holds,
		active: () => holds.filter((hold) => !hold.released),
		offline: {
			status: () => ({}),
			subscribe: () => () => {},
			hold: async (q: OfflineKeepQuery, _options?: OfflineKeepOptions) => {
				if (refuse) throw refuse
				const hold = { where: q.getDescriptor().where, released: false }
				holds.push(hold)
				return async () => {
					hold.released = true
				}
			},
		},
	}
}

function mountWith(offline: unknown, setup: () => ReturnType<typeof useOfflineKeep>) {
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
			const result = setup()
			return () =>
				h(
					'span',
					{ 'data-testid': 'state' },
					`${result.held.value}:${result.error.value?.message ?? ''}`,
				)
		},
	})
	return mount(Comp, { global: { provide: { [koraContextKey]: contextRef } } })
}

describe('useOfflineKeep (Vue)', () => {
	it('holds while the component lives and releases when it unmounts', async () => {
		const fake = fakeOffline()
		const wrapper = mountWith(fake.offline, () =>
			useOfflineKeep(query({ courseId: 'c1' }), { files: true }),
		)
		await flushPromises()
		expect(wrapper.get('[data-testid="state"]').text()).toBe('true:')
		expect(fake.active()).toHaveLength(1)
		wrapper.unmount()
		await flushPromises()
		expect(fake.active()).toHaveLength(0)
	})

	it('follows a getter: a new query releases the old pin and holds the new one', async () => {
		const fake = fakeOffline()
		const course = shallowRef('c1')
		const wrapper = mountWith(fake.offline, () =>
			useOfflineKeep(() => query({ courseId: course.value })),
		)
		await flushPromises()
		course.value = 'c2'
		await nextTick()
		await flushPromises()
		expect(fake.active().map((hold) => hold.where)).toEqual([{ courseId: 'c2' }])
		expect(fake.holds).toHaveLength(2)
		wrapper.unmount()
		await flushPromises()
		expect(fake.active()).toHaveLength(0)
	})

	it('reports an unsupported query and holds nothing', async () => {
		const fake = fakeOffline()
		const wrapper = mountWith(fake.offline, () =>
			useOfflineKeep(query({}, { include: ['course'] })),
		)
		await flushPromises()
		expect(wrapper.get('[data-testid="state"]').text()).toMatch(/^false:.*include/)
		expect(fake.holds).toEqual([])
	})

	it('reports a refused hold', async () => {
		const fake = fakeOffline(new Error('64 pins'))
		const wrapper = mountWith(fake.offline, () => useOfflineKeep(query({ courseId: 'c1' })))
		await flushPromises()
		expect(wrapper.get('[data-testid="state"]').text()).toBe('false:64 pins')
	})

	it('does nothing without app.offline', async () => {
		const wrapper = mountWith(undefined, () => useOfflineKeep(query({})))
		await flushPromises()
		expect(wrapper.get('[data-testid="state"]').text()).toBe('false:')
	})
})

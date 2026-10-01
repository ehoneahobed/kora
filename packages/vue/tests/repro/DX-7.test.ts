import type { CollectionRecord, QueryBuilder, SubscriptionCallback } from '@korajs/store'
import { QueryStoreCache } from '@korajs/store'
import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, shallowRef } from 'vue'
import { useQuery } from '../../src/composables/use-query'
import { koraContextKey } from '../../src/context'
import type { KoraContextValue } from '../../src/types'

/**
 * DX-7: a Vue composable must react to prop/ref changes. useQuery accepts only
 * a QueryBuilder value captured once in setup(), so a component whose filter
 * prop changes keeps showing the first query's rows. Correct: accept
 * MaybeRefOrGetter<QueryBuilder> and re-subscribe when it changes.
 */
function qb(rows: CollectionRecord[], filter: string): QueryBuilder {
	return {
		subscribe: vi.fn((cb: SubscriptionCallback<CollectionRecord>) => {
			cb(rows)
			return vi.fn()
		}),
		getDescriptor: vi.fn().mockReturnValue({ collection: 'todos', where: { filter }, orderBy: [] }),
	} as unknown as QueryBuilder
}
const rec = (id: string): CollectionRecord => ({ id, createdAt: 1, updatedAt: 1 })

describe('DX-7 Vue useQuery reacts to changing inputs', () => {
	it('re-runs when the getter-provided query changes (prop-driven filter)', async () => {
		const queries: Record<string, QueryBuilder> = {
			open: qb([rec('open-1')], 'open'),
			done: qb([rec('done-1')], 'done'),
		}
		const contextRef = shallowRef<KoraContextValue | null>({
			store: {} as KoraContextValue['store'],
			syncEngine: null,
			app: null,
			events: null,
			subscribeSyncStatus: null,
			queryStoreCache: new QueryStoreCache(),
		})
		const Comp = defineComponent({
			props: { filter: { type: String, required: true } },
			setup(props) {
				// Idiomatic Vue: pass a getter so the query tracks props.
				const rows = useQuery((() => queries[props.filter]) as unknown as QueryBuilder)
				return () => h('div', JSON.stringify(rows.value.map((r) => r.id)))
			},
		})
		const wrapper = mount(Comp, {
			props: { filter: 'open' },
			global: { provide: { [koraContextKey]: contextRef } },
		})
		expect(wrapper.text()).toBe('["open-1"]')
		await wrapper.setProps({ filter: 'done' })
		await nextTick()
		expect(wrapper.text()).toBe('["done-1"]')
	})
})

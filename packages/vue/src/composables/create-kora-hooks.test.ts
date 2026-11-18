import type { QueryBuilder } from '@korajs/store'
import { mount } from '@vue/test-utils'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { defineComponent, h, shallowRef } from 'vue'
import { koraContextKey } from '../context'
import type { KoraAppLike, KoraContextValue } from '../types'
import { type AppCollectionName, type AppRecord, createKoraHooks } from './create-kora-hooks'

interface Todo {
	id: string
	title: string
	completed: boolean
	createdAt: number
	updatedAt: number
}
interface TodosAccessor {
	insert(data: { title: string; completed?: boolean }): Promise<Todo>
	where(conditions: Record<string, unknown>): QueryBuilder<Todo>
}
type App = KoraAppLike & { collections: { todos: TodosAccessor } }

describe('createKoraHooks (Vue)', () => {
	it('types collection names, records and accessors from the app type', () => {
		const hooks = createKoraHooks<App>()
		expectTypeOf<AppCollectionName<App>>().toEqualTypeOf<'todos'>()
		expectTypeOf<AppRecord<App, 'todos'>>().toEqualTypeOf<Todo>()
		expectTypeOf(hooks.useCollection<'todos'>).returns.toEqualTypeOf<TodosAccessor>()
		expectTypeOf(hooks.useApp).returns.toEqualTypeOf<App>()
		// @ts-expect-error 'todoz' is not a collection of App
		expectTypeOf(hooks.useCollection).toBeCallableWith('todoz')
	})

	it("useCollection returns the app's own accessor, and useApp the app", () => {
		const todos = { insert: vi.fn(), where: vi.fn() } as unknown as TodosAccessor
		const app = { ready: Promise.resolve(), collections: { todos } } as unknown as App
		const contextRef = shallowRef<KoraContextValue | null>({
			store: { collection: vi.fn() } as unknown as KoraContextValue['store'],
			syncEngine: null,
			app,
			events: null,
			subscribeSyncStatus: null,
			queryStoreCache: {} as KoraContextValue['queryStoreCache'],
		})
		const { useApp, useCollection } = createKoraHooks<App>()
		let seen: { app: App; todos: TodosAccessor } | null = null
		mount(
			defineComponent({
				setup() {
					seen = { app: useApp(), todos: useCollection('todos') }
					return () => h('div')
				},
			}),
			{ global: { provide: { [koraContextKey]: contextRef } } },
		)
		expect(seen?.app).toBe(app)
		expect(seen?.todos).toBe(todos)
	})
})

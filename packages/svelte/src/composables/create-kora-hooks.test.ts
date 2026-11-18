import type { QueryBuilder } from '@korajs/store'
import { describe, expect, expectTypeOf, test, vi } from 'vitest'
import type { KoraAppLike } from '../types'
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

const todos = { insert: vi.fn(), where: vi.fn() } as unknown as TodosAccessor
const app = { ready: Promise.resolve(), collections: { todos } } as unknown as App
const store = { collection: vi.fn() }
vi.mock('../context', () => ({
	getKoraContext: () => ({ app, store, syncEngine: null, subscribeSyncStatus: null, events: null }),
}))

describe('createKoraHooks (Svelte)', () => {
	test('types collection names, records and accessors from the app type', () => {
		const hooks = createKoraHooks<App>()
		expectTypeOf<AppCollectionName<App>>().toEqualTypeOf<'todos'>()
		expectTypeOf<AppRecord<App, 'todos'>>().toEqualTypeOf<Todo>()
		expectTypeOf(hooks.useCollection<'todos'>).returns.toEqualTypeOf<TodosAccessor>()
		expectTypeOf(hooks.useApp).returns.toEqualTypeOf<App>()
		// @ts-expect-error 'todoz' is not a collection of App
		expectTypeOf(hooks.useCollection).toBeCallableWith('todoz')
	})

	test("useCollection returns the app's own accessor, and useApp the app", () => {
		const { useApp, useCollection, getCollection } = createKoraHooks<App>()
		expect(useApp()).toBe(app)
		expect(useCollection('todos')).toBe(todos)
		expect(getCollection).toBe(useCollection)
		expect(store.collection).not.toHaveBeenCalled()
	})
})

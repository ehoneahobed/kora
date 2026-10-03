import type { QueryBuilder } from '@korajs/store'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { createFakeApp, createFakeQuery, row } from '../../tests/fixtures/fake-query'
import { KoraProvider } from '../context/kora-context'
import type { KoraAppLike } from '../types'
import { type AppCollectionName, type AppRecord, createKoraHooks } from './create-kora-hooks'

afterEach(() => {
	cleanup()
})

interface Todo {
	id: string
	title: string
	completed: boolean
	createdAt: number
	updatedAt: number
}

interface TodosAccessor {
	insert(data: { title: string; completed?: boolean }): Promise<Todo>
	update(id: string, data: Partial<{ title: string; completed: boolean }>): Promise<Todo>
	findById(id: string): Promise<Todo | null>
	delete(id: string): Promise<void>
	where(conditions: Record<string, unknown>): QueryBuilder<Todo>
}

// The shape createApp infers: a `collections` namespace of typed accessors.
type App = KoraAppLike & { collections: { todos: TodosAccessor } }

describe('createKoraHooks', () => {
	it('types collection names, records and accessors from the app type', () => {
		const hooks = createKoraHooks<App>()
		expectTypeOf<AppCollectionName<App>>().toEqualTypeOf<'todos'>()
		expectTypeOf<AppRecord<App, 'todos'>>().toEqualTypeOf<Todo>()
		expectTypeOf(hooks.useCollection<'todos'>).returns.toEqualTypeOf<TodosAccessor>()
		expectTypeOf(hooks.useApp).returns.toEqualTypeOf<App>()
		// @ts-expect-error 'todoz' is not a collection of App
		expectTypeOf(hooks.useCollection).toBeCallableWith('todoz')
	})

	it('returns the app accessor, stable across renders, and typed rows from useQuery', async () => {
		const fake = createFakeQuery('typed', [row('a')])
		const todos = {
			insert: vi.fn(),
			update: vi.fn(),
			findById: vi.fn(),
			delete: vi.fn(),
			where: vi.fn(() => fake.query),
		}
		let reads = 0
		const collections = {
			get todos() {
				reads++
				return todos
			},
		}
		const app = createFakeApp({ collections }) as unknown as App
		const { useCollection, useQuery } = createKoraHooks<App>()
		const wrapper = ({ children }: { children: ReactNode }) =>
			createElement(KoraProvider, { app }, children)

		const { result, rerender } = renderHook(
			() => {
				const accessor = useCollection('todos')
				const rows = useQuery(accessor.where({ completed: false }))
				return { accessor, rows }
			},
			{ wrapper },
		)
		await waitFor(() => expect(result.current.rows).toHaveLength(1))
		expectTypeOf(result.current.rows).toEqualTypeOf<readonly Todo[]>()
		const first = result.current.accessor
		const readsAfterMount = reads
		rerender()
		expect(result.current.accessor).toBe(first)
		expect(result.current.accessor).toBe(todos)
		expect(reads).toBe(readsAfterMount)
	})
})

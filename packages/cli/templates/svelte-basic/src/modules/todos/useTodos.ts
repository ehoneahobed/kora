import { createMutation, createQueryStore, getCollection } from '@korajs/svelte'
import { derived } from 'svelte/store'
import {
	type CreateTodoInput,
	type UpdateTodoStatusInput,
	createTodo,
	deleteTodo,
	updateTodoStatus,
} from './todo.mutations'
import { orderedTodos } from './todo.queries'

export function createTodosStores() {
	const todos = getCollection('todos')
	const allTodos = createQueryStore(orderedTodos(todos))
	const addTodo = createMutation((data: CreateTodoInput) => createTodo(todos, data))
	const toggleTodo = createMutation((id: string, data: UpdateTodoStatusInput) =>
		updateTodoStatus(todos, id, data),
	)
	const removeTodo = createMutation((id: string) => deleteTodo(todos, id))

	const activeTodos = derived(allTodos, ($all) => $all.filter((todo) => !todo.completed))
	const completedTodos = derived(allTodos, ($all) => $all.filter((todo) => !!todo.completed))

	return { allTodos, activeTodos, completedTodos, addTodo, toggleTodo, deleteTodo: removeTodo }
}

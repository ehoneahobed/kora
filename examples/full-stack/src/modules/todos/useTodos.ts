import { useCollection, useMutation, useQuery } from '@korajs/react'
import {
	type CreateTodoInput,
	type UpdateTodoStatusInput,
	createTodo,
	deleteTodo,
	updateTodoStatus,
} from './todo.mutations'
import { orderedTodos } from './todo.queries'

export function useTodos() {
	const todos = useCollection('todos')
	const allTodos = useQuery(orderedTodos(todos))
	const addTodo = useMutation((data: CreateTodoInput) => createTodo(todos, data))
	const toggleTodo = useMutation((id: string, data: UpdateTodoStatusInput) =>
		updateTodoStatus(todos, id, data),
	)
	const removeTodo = useMutation((id: string) => deleteTodo(todos, id))

	const activeTodos = allTodos.filter((todo) => !todo.completed)
	const completedTodos = allTodos.filter((todo) => !!todo.completed)

	return {
		allTodos,
		activeTodos,
		completedTodos,
		addTodo,
		toggleTodo,
		deleteTodo: removeTodo,
	}
}

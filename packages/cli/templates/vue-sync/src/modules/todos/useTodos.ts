import { computed } from 'vue'
import { useCollection, useMutation, useQuery } from '@korajs/vue'
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

	const activeTodos = computed(() => allTodos.value.filter((todo) => !todo.completed))
	const completedTodos = computed(() => allTodos.value.filter((todo) => !!todo.completed))

	return {
		allTodos,
		activeTodos,
		completedTodos,
		addTodo,
		toggleTodo,
		deleteTodo: removeTodo,
	}
}

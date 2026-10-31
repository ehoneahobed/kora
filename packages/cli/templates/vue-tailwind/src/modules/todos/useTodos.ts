import { useCollection, useMutation, useQueryState } from '@korajs/vue'
import { computed } from 'vue'
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
	// `loaded` is false until the local database has opened and answered: an empty list before
	// that is "not here yet", not "no tasks".
	const { data: allTodos, ready: loaded } = useQueryState(orderedTodos(todos))
	const addTodo = useMutation((data: CreateTodoInput) => createTodo(todos, data))
	const toggleTodo = useMutation((id: string, data: UpdateTodoStatusInput) =>
		updateTodoStatus(todos, id, data),
	)
	const removeTodo = useMutation((id: string) => deleteTodo(todos, id))

	const activeTodos = computed(() => allTodos.value.filter((todo) => !todo.completed))
	const completedTodos = computed(() => allTodos.value.filter((todo) => !!todo.completed))

	return {
		loaded,
		allTodos,
		activeTodos,
		completedTodos,
		addTodo,
		toggleTodo,
		deleteTodo: removeTodo,
	}
}

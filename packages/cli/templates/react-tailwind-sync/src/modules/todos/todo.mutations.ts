import type { Todos } from '../../kora'

export interface CreateTodoInput {
	title: string
}

export interface UpdateTodoStatusInput {
	completed: boolean
}

export function createTodo(todos: Todos, data: CreateTodoInput) {
	return todos.insert({ title: data.title })
}

export function updateTodoStatus(todos: Todos, id: string, data: UpdateTodoStatusInput) {
	return todos.update(id, { completed: data.completed })
}

export function deleteTodo(todos: Todos, id: string) {
	return todos.delete(id)
}

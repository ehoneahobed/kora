import type { Todos } from '../../kora'

export function orderedTodos(todos: Todos) {
	return todos.where({}).orderBy('createdAt', 'desc')
}

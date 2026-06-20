import type { CollectionAccessor } from 'korajs'

export function orderedTodos(todos: CollectionAccessor) {
	return todos.where({}).orderBy('createdAt', 'desc')
}

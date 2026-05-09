import type { CollectionAccessor } from 'korajs'

export interface CreateTodoInput {
  title: string
}

export interface UpdateTodoStatusInput {
  completed: boolean
}

export function createTodo(todos: CollectionAccessor, data: CreateTodoInput) {
  return todos.insert({ title: data.title })
}

export function updateTodoStatus(
  todos: CollectionAccessor,
  id: string,
  data: UpdateTodoStatusInput,
) {
  return todos.update(id, { completed: data.completed })
}

export function deleteTodo(todos: CollectionAccessor, id: string) {
  return todos.delete(id)
}

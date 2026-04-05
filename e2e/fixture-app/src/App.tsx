import { useQuery, useMutation, useSyncStatus, useCollection } from '@kora/react'

export function App() {
  const todos = useCollection('todos')
  const allTodos = useQuery(todos.where({}))
  const { mutate: addTodo } = useMutation(
    (data: { title: string }) => todos.insert(data)
  )
  const { mutate: toggleTodo } = useMutation(
    (id: string, data: { completed: boolean }) => todos.update(id, data)
  )
  const { mutate: deleteTodo } = useMutation(
    (id: string) => todos.delete(id)
  )
  const status = useSyncStatus()

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', padding: 20 }}>
      <h1 data-testid="heading">Kora E2E Todo</h1>
      <p data-testid="sync-status">Status: {status.status}</p>

      <form
        data-testid="add-form"
        onSubmit={async (e) => {
          e.preventDefault()
          const form = e.currentTarget
          const input = form.elements.namedItem('title') as HTMLInputElement
          if (input.value.trim()) {
            addTodo({ title: input.value.trim() })
            input.value = ''
          }
        }}
      >
        <input data-testid="title-input" name="title" placeholder="What needs to be done?" />
        <button data-testid="add-button" type="submit">Add</button>
      </form>

      <ul data-testid="todo-list">
        {allTodos.map((todo) => (
          <li key={todo.id} data-testid={`todo-${todo.id}`}>
            <label>
              <input
                data-testid={`toggle-${todo.id}`}
                type="checkbox"
                checked={!!todo.completed}
                onChange={() => toggleTodo(todo.id, { completed: !todo.completed })}
              />
              <span data-testid={`title-${todo.id}`}>{String(todo.title)}</span>
            </label>
            <button
              data-testid={`delete-${todo.id}`}
              onClick={() => deleteTodo(todo.id)}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>

      <p data-testid="todo-count">Count: {allTodos.length}</p>
    </div>
  )
}

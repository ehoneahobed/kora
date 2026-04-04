import { useQuery, useMutation, useSyncStatus } from '@kora/react'

export function App() {
  const todos = useQuery(app => app.todos.where({ completed: false }).orderBy('createdAt'))
  const addTodo = useMutation(app => app.todos.insert)
  const toggleTodo = useMutation(app => app.todos.update)
  const status = useSyncStatus()

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', padding: 20 }}>
      <h1>Kora Todo App</h1>
      <p>Status: {status}</p>

      <form
        onSubmit={async (e) => {
          e.preventDefault()
          const form = e.currentTarget
          const input = form.elements.namedItem('title') as HTMLInputElement
          if (input.value.trim()) {
            await addTodo({ title: input.value.trim() })
            input.value = ''
          }
        }}
      >
        <input name="title" placeholder="What needs to be done?" />
        <button type="submit">Add</button>
      </form>

      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>
            <label>
              <input
                type="checkbox"
                checked={todo.completed}
                onChange={() => toggleTodo(todo.id, { completed: !todo.completed })}
              />
              {todo.title}
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}

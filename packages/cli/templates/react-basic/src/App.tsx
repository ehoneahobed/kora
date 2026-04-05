import { useQuery, useMutation, useCollection } from '@korajs/react'

export function App() {
  const todos = useCollection('todos')
  const activeTodos = useQuery(todos.where({ completed: false }))
  const { mutate: addTodo } = useMutation(
    (data: { title: string }) => todos.insert(data)
  )
  const { mutate: toggleTodo } = useMutation(
    (id: string, data: { completed: boolean }) => todos.update(id, data)
  )

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', padding: 20 }}>
      <h1>Kora Todo App</h1>

      <form
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
        <input name="title" placeholder="What needs to be done?" />
        <button type="submit">Add</button>
      </form>

      <ul>
        {activeTodos.map((todo) => (
          <li key={todo.id}>
            <label>
              <input
                type="checkbox"
                checked={!!todo.completed}
                onChange={() => toggleTodo(todo.id, { completed: !todo.completed })}
              />
              {String(todo.title)}
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}

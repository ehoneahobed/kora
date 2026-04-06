import { useState } from 'react'
import { useQuery, useMutation, useSyncStatus, useCollection } from '@korajs/react'

type Filter = 'all' | 'active' | 'completed'

export function App() {
  const todos = useCollection('todos')
  const allTodos = useQuery(todos.orderBy('createdAt', 'desc'))
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

  const [filter, setFilter] = useState<Filter>('all')
  const [input, setInput] = useState('')

  const activeTodos = allTodos.filter((t) => !t.completed)
  const completedTodos = allTodos.filter((t) => !!t.completed)
  const filteredTodos =
    filter === 'active' ? activeTodos : filter === 'completed' ? completedTodos : allTodos

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const title = input.trim()
    if (title) {
      addTodo({ title })
      setInput('')
    }
  }

  const clearCompleted = () => {
    for (const todo of completedTodos) {
      deleteTodo(todo.id)
    }
  }

  return (
    <div className="app">
      <div className="header">
        <h1>My Tasks</h1>
        <div className="sync-badge">
          <span className={`sync-dot ${status.status}`} />
          <span>{status.status}</span>
        </div>
      </div>

      <div className="stats">
        <div className="stat-card">
          <div className="label">Total</div>
          <div className="value muted">{allTodos.length}</div>
        </div>
        <div className="stat-card">
          <div className="label">Remaining</div>
          <div className="value warning">{activeTodos.length}</div>
        </div>
        <div className="stat-card">
          <div className="label">Done</div>
          <div className="value success">{completedTodos.length}</div>
        </div>
      </div>

      <form className="add-form" onSubmit={handleSubmit}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="What needs to be done?"
        />
        <button type="submit" disabled={!input.trim()}>
          Add
        </button>
      </form>

      <div className="filters">
        {(['all', 'active', 'completed'] as const).map((f) => {
          const count = f === 'all' ? allTodos.length : f === 'active' ? activeTodos.length : completedTodos.length
          return (
            <button
              key={f}
              className={`filter-btn ${filter === f ? 'active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
              <span className="badge">{count}</span>
            </button>
          )
        })}
      </div>

      <div className="todo-list">
        {filteredTodos.length === 0 ? (
          <div className="empty-state">
            {filter === 'all' && 'No tasks yet. Add one above!'}
            {filter === 'active' && 'All caught up! No active tasks.'}
            {filter === 'completed' && 'No completed tasks yet.'}
          </div>
        ) : (
          filteredTodos.map((todo) => (
            <div key={todo.id} className="todo-item">
              <button
                className={`toggle ${todo.completed ? 'checked' : ''}`}
                onClick={() => toggleTodo(todo.id, { completed: !todo.completed })}
              >
                {todo.completed ? '\u2713' : ''}
              </button>
              <span className={`title ${todo.completed ? 'done' : ''}`}>
                {String(todo.title)}
              </span>
              {todo.createdAt && (
                <span className="time">{formatTime(Number(todo.createdAt))}</span>
              )}
              <button
                className="delete-btn"
                onClick={() => deleteTodo(todo.id)}
              >
                \u00d7
              </button>
            </div>
          ))
        )}
      </div>

      {allTodos.length > 0 && (
        <div className="footer">
          <span>{activeTodos.length} item{activeTodos.length !== 1 ? 's' : ''} left</span>
          {completedTodos.length > 0 && (
            <button onClick={clearCompleted}>Clear completed</button>
          )}
        </div>
      )}

      <p className="branding">Powered by Kora &mdash; offline-first, real-time sync</p>
    </div>
  )
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

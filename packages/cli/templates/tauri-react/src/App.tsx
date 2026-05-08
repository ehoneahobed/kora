import { useState } from 'react'
import { useQuery, useMutation, useCollection } from '@korajs/react'
import {
  CheckCircle2,
  Circle,
  Monitor,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react'

type Filter = 'all' | 'active' | 'completed'

export function App() {
  const todos = useCollection('todos')
  const allTodos = useQuery(todos.where({}).orderBy('createdAt', 'desc'))
  const { mutate: addTodo, isLoading: isAdding } = useMutation(
    (data: { title: string }) => todos.insert(data)
  )
  const { mutate: toggleTodo } = useMutation(
    (id: string, data: { completed: boolean }) => todos.update(id, data)
  )
  const { mutate: deleteTodo } = useMutation(
    (id: string) => todos.delete(id)
  )

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
    <div style={{ minHeight: '100vh', background: '#0a0a0a', color: '#f3f4f6' }}>
      <div style={{ maxWidth: '640px', margin: '0 auto', padding: '48px 16px' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '32px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <Monitor style={{ width: '32px', height: '32px', color: '#818cf8' }} />
            <h1 style={{ fontSize: '24px', fontWeight: 'bold' }}>Desktop Tasks</h1>
          </div>
          <span style={{ fontSize: '12px', color: '#6b7280', background: '#1f2937', padding: '4px 12px', borderRadius: '9999px' }}>
            Native SQLite
          </span>
        </div>

        {/* Stats */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px', marginBottom: '32px' }}>
          <StatCard label="Total" value={allTodos.length} color="#d1d5db" />
          <StatCard label="Remaining" value={activeTodos.length} color="#fbbf24" />
          <StatCard label="Done" value={completedTodos.length} color="#34d399" />
        </div>

        {/* Add form */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', gap: '12px', marginBottom: '32px' }}>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="What needs to be done?"
            style={{
              flex: 1,
              borderRadius: '8px',
              border: '1px solid #374151',
              background: '#111827',
              padding: '12px 16px',
              color: '#f3f4f6',
              outline: 'none',
              fontSize: '14px',
            }}
          />
          <button
            type="submit"
            disabled={isAdding || !input.trim()}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              borderRadius: '8px',
              background: '#4f46e5',
              padding: '12px 20px',
              fontWeight: '500',
              color: 'white',
              border: 'none',
              cursor: 'pointer',
              opacity: isAdding || !input.trim() ? 0.5 : 1,
              fontSize: '14px',
            }}
          >
            {isAdding ? <Loader2 style={{ width: '16px', height: '16px', animation: 'spin 1s linear infinite' }} /> : <Plus style={{ width: '16px', height: '16px' }} />}
            Add
          </button>
        </form>

        {/* Filter tabs */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '24px' }}>
          {(['all', 'active', 'completed'] as const).map((f) => {
            const count = f === 'all' ? allTodos.length : f === 'active' ? activeTodos.length : completedTodos.length
            const isActive = filter === f
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  borderRadius: '8px',
                  padding: '8px 16px',
                  fontSize: '14px',
                  fontWeight: '500',
                  border: 'none',
                  cursor: 'pointer',
                  background: isActive ? '#4f46e5' : '#1f2937',
                  color: isActive ? 'white' : '#9ca3af',
                }}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
                <span style={{
                  borderRadius: '9999px',
                  padding: '2px 8px',
                  fontSize: '12px',
                  background: isActive ? '#4338ca' : '#374151',
                  color: isActive ? 'white' : '#9ca3af',
                }}>
                  {count}
                </span>
              </button>
            )
          })}
        </div>

        {/* Todo list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {filteredTodos.length === 0 ? (
            <div style={{ borderRadius: '8px', border: '1px dashed #1f2937', padding: '48px 0', textAlign: 'center', color: '#4b5563' }}>
              {filter === 'all' ? 'No tasks yet. Add one above!' : filter === 'active' ? 'All caught up!' : 'No completed tasks yet.'}
            </div>
          ) : (
            filteredTodos.map((todo) => (
              <div
                key={todo.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  borderRadius: '8px',
                  border: '1px solid #1f2937',
                  background: '#111827',
                  padding: '12px 16px',
                }}
              >
                <button
                  onClick={() => toggleTodo(todo.id, { completed: !todo.completed })}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                >
                  {todo.completed ? (
                    <CheckCircle2 style={{ width: '20px', height: '20px', color: '#34d399' }} />
                  ) : (
                    <Circle style={{ width: '20px', height: '20px', color: '#6b7280' }} />
                  )}
                </button>
                <span style={{
                  flex: 1,
                  color: todo.completed ? '#6b7280' : '#f3f4f6',
                  textDecoration: todo.completed ? 'line-through' : 'none',
                }}>
                  {String(todo.title)}
                </span>
                {todo.createdAt && (
                  <span style={{ fontSize: '12px', color: '#374151' }}>
                    {formatTime(Number(todo.createdAt))}
                  </span>
                )}
                <button
                  onClick={() => deleteTodo(todo.id)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: '#4b5563' }}
                >
                  <Trash2 style={{ width: '16px', height: '16px' }} />
                </button>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        {allTodos.length > 0 && (
          <div style={{ marginTop: '24px', display: 'flex', justifyContent: 'space-between', fontSize: '14px', color: '#6b7280' }}>
            <span>{activeTodos.length} item{activeTodos.length !== 1 ? 's' : ''} left</span>
            {completedTodos.length > 0 && (
              <button
                onClick={clearCompleted}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', fontSize: '14px' }}
              >
                Clear completed
              </button>
            )}
          </div>
        )}

        <p style={{ marginTop: '48px', textAlign: 'center', fontSize: '12px', color: '#374151' }}>
          Powered by Kora &mdash; native SQLite, offline-first
        </p>
      </div>
    </div>
  )
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ borderRadius: '8px', border: '1px solid #1f2937', background: '#111827', padding: '16px' }}>
      <p style={{ fontSize: '14px', color: '#6b7280' }}>{label}</p>
      <p style={{ fontSize: '24px', fontWeight: 'bold', color }}>{value}</p>
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

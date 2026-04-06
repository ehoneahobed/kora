import { useState } from 'react'
import { useQuery, useMutation, useSyncStatus, useCollection } from '@korajs/react'
import {
  CheckCircle2,
  Circle,
  ClipboardList,
  Loader2,
  Plus,
  Trash2,
  Wifi,
  WifiOff,
  AlertCircle,
} from 'lucide-react'

type Filter = 'all' | 'active' | 'completed'

export function App() {
  const todos = useCollection('todos')
  const allTodos = useQuery(todos.orderBy('createdAt', 'desc'))
  const { mutate: addTodo, isPending: isAdding } = useMutation(
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
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <div className="mx-auto max-w-2xl px-4 py-12">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <ClipboardList className="h-8 w-8 text-indigo-400" />
            <h1 className="text-2xl font-bold">My Tasks</h1>
          </div>
          <SyncBadge status={status} />
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <StatCard label="Total" value={allTodos.length} color="text-gray-300" />
          <StatCard label="Remaining" value={activeTodos.length} color="text-amber-400" />
          <StatCard label="Done" value={completedTodos.length} color="text-emerald-400" />
        </div>

        {/* Add form */}
        <form onSubmit={handleSubmit} className="flex gap-3 mb-8">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="What needs to be done?"
            className="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-4 py-3 text-gray-100 placeholder-gray-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
          />
          <button
            type="submit"
            disabled={isAdding || !input.trim()}
            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-3 font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isAdding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Add
          </button>
        </form>

        {/* Filter tabs */}
        <div className="flex gap-2 mb-6">
          {(['all', 'active', 'completed'] as const).map((f) => {
            const count = f === 'all' ? allTodos.length : f === 'active' ? activeTodos.length : completedTodos.length
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition ${
                  filter === f
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
                }`}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${
                    filter === f ? 'bg-indigo-500 text-white' : 'bg-gray-700 text-gray-400'
                  }`}
                >
                  {count}
                </span>
              </button>
            )
          })}
        </div>

        {/* Todo list */}
        <div className="space-y-2">
          {filteredTodos.length === 0 ? (
            <EmptyState filter={filter} />
          ) : (
            filteredTodos.map((todo) => (
              <div
                key={todo.id}
                className="group flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-900 px-4 py-3 transition hover:border-gray-700"
              >
                <button
                  onClick={() => toggleTodo(todo.id, { completed: !todo.completed })}
                  className="shrink-0 text-gray-500 hover:text-indigo-400 transition"
                >
                  {todo.completed ? (
                    <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                  ) : (
                    <Circle className="h-5 w-5" />
                  )}
                </button>
                <span
                  className={`flex-1 ${
                    todo.completed ? 'text-gray-500 line-through' : 'text-gray-100'
                  }`}
                >
                  {String(todo.title)}
                </span>
                {todo.createdAt && (
                  <span className="text-xs text-gray-600">
                    {formatTime(Number(todo.createdAt))}
                  </span>
                )}
                <button
                  onClick={() => deleteTodo(todo.id)}
                  className="shrink-0 text-gray-600 opacity-0 transition hover:text-red-400 group-hover:opacity-100"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        {allTodos.length > 0 && (
          <div className="mt-6 flex items-center justify-between text-sm text-gray-500">
            <span>{activeTodos.length} item{activeTodos.length !== 1 ? 's' : ''} left</span>
            {completedTodos.length > 0 && (
              <button
                onClick={clearCompleted}
                className="text-gray-500 transition hover:text-gray-300"
              >
                Clear completed
              </button>
            )}
          </div>
        )}

        <p className="mt-12 text-center text-xs text-gray-700">
          Powered by Kora &mdash; offline-first, real-time sync
        </p>
      </div>
    </div>
  )
}

function SyncBadge({ status }: { status: { status: string; pendingOperations?: number } }) {
  const s = status.status
  const pending = status.pendingOperations ?? 0

  const config: Record<string, { icon: typeof Wifi; color: string; label: string }> = {
    connected: { icon: Wifi, color: 'text-emerald-400', label: 'Connected' },
    syncing: { icon: Wifi, color: 'text-amber-400', label: 'Syncing' },
    synced: { icon: Wifi, color: 'text-emerald-400', label: 'Synced' },
    offline: { icon: WifiOff, color: 'text-gray-500', label: 'Offline' },
    error: { icon: AlertCircle, color: 'text-red-400', label: 'Error' },
  }

  const { icon: Icon, color, label } = config[s] ?? config.offline!

  return (
    <div className="flex items-center gap-2 rounded-full bg-gray-800 px-3 py-1.5 text-sm">
      <Icon className={`h-4 w-4 ${color}`} />
      <span className={color}>{label}</span>
      {pending > 0 && (
        <span className="rounded-full bg-gray-700 px-2 py-0.5 text-xs text-gray-400">
          {pending} pending
        </span>
      )}
    </div>
  )
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <p className="text-sm text-gray-500">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
    </div>
  )
}

function EmptyState({ filter }: { filter: Filter }) {
  const messages: Record<Filter, string> = {
    all: 'No tasks yet. Add one above!',
    active: 'All caught up! No active tasks.',
    completed: 'No completed tasks yet.',
  }
  return (
    <div className="rounded-lg border border-dashed border-gray-800 py-12 text-center text-gray-600">
      {messages[filter]}
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

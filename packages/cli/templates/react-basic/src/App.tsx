import { useFormDraft } from '@korajs/react'
import { useRef, useState } from 'react'
import { OfflineBadge } from './OfflineBadge'
import { useTodos } from './modules/todos/useTodos'

type Filter = 'all' | 'active' | 'completed'

export function App() {
	const { allTodos, activeTodos, completedTodos, addTodo, toggleTodo, deleteTodo } = useTodos()

	const [filter, setFilter] = useState<Filter>('all')
	// What is typed in the new-task field survives the reload a new version of the app asks
	// for (opt-in, only the listed field). Never draft passwords or sensitive answers.
	const draft = useFormDraft('new-todo', { title: '' }, { fields: ['title'], collection: 'todos' })
	const input = draft.values.title

	const filteredTodos =
		filter === 'active' ? activeTodos : filter === 'completed' ? completedTodos : allTodos

	// One submit at a time (Enter pressed twice inserts once), and the field is cleared only
	// if it still holds what was submitted: text typed for the next task while the write was
	// pending is kept.
	const submitting = useRef(false)
	const latestInput = useRef(input)
	latestInput.current = input
	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault()
		const submitted = input
		const title = submitted.trim()
		if (!title || submitting.current) return
		submitting.current = true
		// The draft is cleared once the write is stored; a refused write keeps it.
		addTodo
			.mutateAsync({ title })
			.then(() => {
				if (latestInput.current === submitted) draft.clear()
			})
			.catch(() => {})
			.finally(() => {
				submitting.current = false
			})
	}

	const clearCompleted = () => {
		for (const todo of completedTodos) {
			deleteTodo.mutate(todo.id)
		}
	}

	return (
		<div className="app">
			<div className="header">
				<h1>My Tasks</h1>
				<div className="header-actions">
					<OfflineBadge />
					<span className="local-badge">Local-first</span>
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
				<input type="text" {...draft.bind('title')} placeholder="What needs to be done?" />
				<button type="submit" disabled={!input.trim()}>
					Add
				</button>
			</form>

			<div className="filters">
				{(['all', 'active', 'completed'] as const).map((f) => {
					const count =
						f === 'all'
							? allTodos.length
							: f === 'active'
								? activeTodos.length
								: completedTodos.length
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
								onClick={() => toggleTodo.mutate(todo.id, { completed: !todo.completed })}
							>
								{todo.completed ? '\u2713' : ''}
							</button>
							<span className={`title ${todo.completed ? 'done' : ''}`}>{String(todo.title)}</span>
							{todo.createdAt && <span className="time">{formatTime(Number(todo.createdAt))}</span>}
							<button className="delete-btn" onClick={() => deleteTodo.mutate(todo.id)}>
								\u00d7
							</button>
						</div>
					))
				)}
			</div>

			{allTodos.length > 0 && (
				<div className="footer">
					<span>
						{activeTodos.length} item{activeTodos.length !== 1 ? 's' : ''} left
					</span>
					{completedTodos.length > 0 && <button onClick={clearCompleted}>Clear completed</button>}
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

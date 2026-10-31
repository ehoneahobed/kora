import { useAuth } from '@korajs/auth/react'
import { useApp, useFormDraft } from '@korajs/react'
import { clearFormDrafts } from 'korajs'
import {
	AlertCircle,
	CheckCircle2,
	Circle,
	ClipboardList,
	Loader2,
	Plus,
	Trash2,
	Wifi,
	WifiOff,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { OfflineBadge } from './OfflineBadge'
import { useSyncStatus } from './kora'
import { useTodos } from './modules/todos/useTodos'

type Filter = 'all' | 'active' | 'completed'

export function App() {
	const { loaded, allTodos, activeTodos, completedTodos, addTodo, toggleTodo, deleteTodo } =
		useTodos()
	const isAdding = addTodo.isLoading
	const status = useSyncStatus()
	const { user, isAuthenticated, isLoading, signInWithOAuth, signOut, error } = useAuth()

	const [filter, setFilter] = useState<Filter>('all')
	// What is typed in the new-task field survives the reload a new version of the app asks
	// for (opt-in, only the listed field). Never draft passwords or sensitive answers.
	const app = useApp()
	// Drafts belong to the signed-in user. While the session loads the user is unknown
	// (undefined): no draft is restored, saved or cleared until it is known.
	const draftUser = isLoading ? undefined : (user?.id ?? null)
	const knownUser = useRef<string | null | undefined>(undefined)
	useEffect(() => {
		if (draftUser === undefined) return
		// Cleared when a known user changes (sign-out, another account), never on the first
		// load of the session.
		if (knownUser.current !== undefined && knownUser.current !== draftUser) clearFormDrafts(app)
		knownUser.current = draftUser
	}, [app, draftUser])
	const signOutAndClearDrafts = async (): Promise<void> => {
		clearFormDrafts(app)
		await signOut()
	}
	const draft = useFormDraft(
		'new-todo',
		{ title: '' },
		{ fields: ['title'], collection: 'todos', userId: draftUser },
	)
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
		<div className="min-h-screen bg-gray-950 text-gray-100">
			<div className="mx-auto max-w-2xl px-4 py-12">
				{/* Header */}
				<div className="flex items-center justify-between mb-8">
					<div className="flex items-center gap-3">
						<ClipboardList className="h-8 w-8 text-indigo-400" />
						<h1 className="text-2xl font-bold">My Tasks</h1>
					</div>
					<div className="flex items-center gap-2">
						<OfflineBadge />
						<SyncBadge status={status} />
						{isAuthenticated ? (
							<button
								type="button"
								onClick={() => void signOutAndClearDrafts()}
								className="max-w-44 truncate rounded-full border border-gray-700 bg-gray-900 px-3 py-1.5 text-sm text-gray-300 transition hover:border-gray-600"
							>
								{user?.email || 'Sign out'}
							</button>
						) : (
							<button
								type="button"
								onClick={() => signInWithOAuth('google')}
								className="rounded-full border border-gray-700 bg-gray-900 px-3 py-1.5 text-sm text-gray-300 transition hover:border-gray-600"
							>
								Sign in
							</button>
						)}
					</div>
				</div>

				{error && (
					<div className="mb-4 rounded-lg border border-red-400/30 px-3 py-2 text-sm text-red-300">
						{error}
					</div>
				)}

				<ClockErrorBanner status={status} />

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
						{...draft.bind('title')}
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
						const count =
							f === 'all'
								? allTodos.length
								: f === 'active'
									? activeTodos.length
									: completedTodos.length
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
					{loaded && filteredTodos.length === 0 ? (
						<EmptyState filter={filter} />
					) : (
						filteredTodos.map((todo) => (
							<div
								key={todo.id}
								className="group flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-900 px-4 py-3 transition hover:border-gray-700"
							>
								<button
									onClick={() => toggleTodo.mutate(todo.id, { completed: !todo.completed })}
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
									onClick={() => deleteTodo.mutate(todo.id)}
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
						<span>
							{activeTodos.length} item{activeTodos.length !== 1 ? 's' : ''} left
						</span>
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
		'clock-error': { icon: AlertCircle, color: 'text-red-400', label: 'Clock error' },
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

/**
 * Shown when sync is paused because this device's clock is set too far ahead.
 * Local changes keep saving; they sync automatically once the clock is fixed.
 */
function ClockErrorBanner({
	status,
}: {
	status: { status: string; clockSkewMs?: number | null }
}) {
	if (status.status !== 'clock-error') return null
	const skew = status.clockSkewMs
	const minutes =
		typeof skew === 'number' && Number.isFinite(skew) ? Math.round(Math.abs(skew) / 60000) : null
	return (
		<div className="mb-4 rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
			<strong>
				This device's clock looks wrong{minutes !== null ? ` (about ${minutes} min ahead)` : ''}.
			</strong>{' '}
			Your changes are safe on this device, but they can't be shared with your other devices until
			the clock is corrected. Open your device's Settings, find Date & Time, and turn on "Set
			automatically", then return here.
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

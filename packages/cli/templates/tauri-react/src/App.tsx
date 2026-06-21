import { useAuth } from '@korajs/auth/react'
import {
	AlertTriangle,
	CheckCircle2,
	Circle,
	Loader2,
	Monitor,
	Plus,
	Settings,
	Trash2,
	Wifi,
	WifiOff,
} from 'lucide-react'
import { useState } from 'react'
import { useTodos } from './modules/todos/useTodos'
import { testConnection } from './sync-config'

type Filter = 'all' | 'active' | 'completed'

interface AppProps {
	syncUrl: string | null
	onChangeServer: (newUrl: string | null) => void
	onFactoryReset: () => void
}

export function App({ syncUrl, onChangeServer, onFactoryReset }: AppProps) {
	const { allTodos, activeTodos, completedTodos, addTodo, toggleTodo, deleteTodo } = useTodos()
	const { user, isAuthenticated, signOut, error } = useAuth()
	const isAdding = addTodo.isLoading

	const [filter, setFilter] = useState<Filter>('all')
	const [input, setInput] = useState('')
	const [showSettings, setShowSettings] = useState(false)

	const filteredTodos =
		filter === 'active' ? activeTodos : filter === 'completed' ? completedTodos : allTodos

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault()
		const title = input.trim()
		if (title) {
			addTodo.mutate({ title })
			setInput('')
		}
	}

	const clearCompleted = () => {
		for (const todo of completedTodos) {
			deleteTodo.mutate(todo.id)
		}
	}

	return (
		<div style={{ minHeight: '100vh', background: '#0a0a0a', color: '#f3f4f6' }}>
			<div style={{ maxWidth: '640px', margin: '0 auto', padding: '48px 16px' }}>
				{/* Header */}
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-between',
						marginBottom: '32px',
					}}
				>
					<div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
						<Monitor style={{ width: '32px', height: '32px', color: '#818cf8' }} />
						<h1 style={{ fontSize: '24px', fontWeight: 'bold' }}>Desktop Tasks</h1>
					</div>
					<div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
						<span
							style={{
								display: 'flex',
								alignItems: 'center',
								gap: '6px',
								fontSize: '12px',
								color: syncUrl ? '#34d399' : '#6b7280',
								background: '#1f2937',
								padding: '4px 12px',
								borderRadius: '9999px',
							}}
						>
							{syncUrl ? (
								<Wifi style={{ width: '12px', height: '12px' }} />
							) : (
								<WifiOff style={{ width: '12px', height: '12px' }} />
							)}
							{syncUrl ? 'Syncing' : 'Local only'}
						</span>
						<AuthButton
							isAuthenticated={isAuthenticated}
							label={user?.email || 'Sign out'}
							onSignOut={signOut}
						/>
						<button
							type="button"
							onClick={() => setShowSettings(!showSettings)}
							style={{
								background: showSettings ? '#374151' : '#1f2937',
								border: 'none',
								borderRadius: '9999px',
								padding: '6px',
								cursor: 'pointer',
								color: showSettings ? '#f3f4f6' : '#6b7280',
								display: 'flex',
							}}
						>
							<Settings style={{ width: '14px', height: '14px' }} />
						</button>
					</div>
				</div>

				{/* Settings panel */}
				{showSettings && (
					<SettingsPanel
						syncUrl={syncUrl}
						onChangeServer={onChangeServer}
						onFactoryReset={onFactoryReset}
						onClose={() => setShowSettings(false)}
					/>
				)}

				{error && (
					<div
						style={{
							border: '1px solid rgba(248, 113, 113, 0.35)',
							borderRadius: '8px',
							color: '#fca5a5',
							fontSize: '13px',
							marginBottom: '16px',
							padding: '10px 12px',
						}}
					>
						{error}
					</div>
				)}

				{/* Stats */}
				<div
					style={{
						display: 'grid',
						gridTemplateColumns: '1fr 1fr 1fr',
						gap: '16px',
						marginBottom: '32px',
					}}
				>
					<StatCard label="Total" value={allTodos.length} color="#d1d5db" />
					<StatCard label="Remaining" value={activeTodos.length} color="#fbbf24" />
					<StatCard label="Done" value={completedTodos.length} color="#34d399" />
				</div>

				{/* Add form */}
				<form
					onSubmit={handleSubmit}
					style={{ display: 'flex', gap: '12px', marginBottom: '32px' }}
				>
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
						{isAdding ? (
							<Loader2
								style={{ width: '16px', height: '16px', animation: 'spin 1s linear infinite' }}
							/>
						) : (
							<Plus style={{ width: '16px', height: '16px' }} />
						)}
						Add
					</button>
				</form>

				{/* Filter tabs */}
				<div style={{ display: 'flex', gap: '8px', marginBottom: '24px' }}>
					{(['all', 'active', 'completed'] as const).map((f) => {
						const count =
							f === 'all'
								? allTodos.length
								: f === 'active'
									? activeTodos.length
									: completedTodos.length
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
								<span
									style={{
										borderRadius: '9999px',
										padding: '2px 8px',
										fontSize: '12px',
										background: isActive ? '#4338ca' : '#374151',
										color: isActive ? 'white' : '#9ca3af',
									}}
								>
									{count}
								</span>
							</button>
						)
					})}
				</div>

				{/* Todo list */}
				<div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
					{filteredTodos.length === 0 ? (
						<div
							style={{
								borderRadius: '8px',
								border: '1px dashed #1f2937',
								padding: '48px 0',
								textAlign: 'center',
								color: '#4b5563',
							}}
						>
							{filter === 'all'
								? 'No tasks yet. Add one above!'
								: filter === 'active'
									? 'All caught up!'
									: 'No completed tasks yet.'}
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
									onClick={() => toggleTodo.mutate(todo.id, { completed: !todo.completed })}
									style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
								>
									{todo.completed ? (
										<CheckCircle2 style={{ width: '20px', height: '20px', color: '#34d399' }} />
									) : (
										<Circle style={{ width: '20px', height: '20px', color: '#6b7280' }} />
									)}
								</button>
								<span
									style={{
										flex: 1,
										color: todo.completed ? '#6b7280' : '#f3f4f6',
										textDecoration: todo.completed ? 'line-through' : 'none',
									}}
								>
									{String(todo.title)}
								</span>
								{todo.createdAt && (
									<span style={{ fontSize: '12px', color: '#374151' }}>
										{formatTime(Number(todo.createdAt))}
									</span>
								)}
								<button
									onClick={() => deleteTodo.mutate(todo.id)}
									style={{
										background: 'none',
										border: 'none',
										cursor: 'pointer',
										padding: 0,
										color: '#4b5563',
									}}
								>
									<Trash2 style={{ width: '16px', height: '16px' }} />
								</button>
							</div>
						))
					)}
				</div>

				{/* Footer */}
				{allTodos.length > 0 && (
					<div
						style={{
							marginTop: '24px',
							display: 'flex',
							justifyContent: 'space-between',
							fontSize: '14px',
							color: '#6b7280',
						}}
					>
						<span>
							{activeTodos.length} item{activeTodos.length !== 1 ? 's' : ''} left
						</span>
						{completedTodos.length > 0 && (
							<button
								onClick={clearCompleted}
								style={{
									background: 'none',
									border: 'none',
									cursor: 'pointer',
									color: '#6b7280',
									fontSize: '14px',
								}}
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

function AuthButton({
	isAuthenticated,
	label,
	onSignOut,
}: {
	isAuthenticated: boolean
	label: string
	onSignOut: () => Promise<void>
}) {
	const { getOAuthAuthorizationUrl } = useAuth()

	const handleSignIn = async () => {
		const { url } = await getOAuthAuthorizationUrl('google')
		window.open(url, '_blank', 'noopener,noreferrer')
	}

	return (
		<button
			type="button"
			onClick={() => (isAuthenticated ? onSignOut() : handleSignIn())}
			style={{
				background: '#1f2937',
				border: '1px solid #374151',
				borderRadius: '9999px',
				color: '#d1d5db',
				cursor: 'pointer',
				fontSize: '12px',
				maxWidth: '160px',
				overflow: 'hidden',
				padding: '4px 12px',
				textOverflow: 'ellipsis',
				whiteSpace: 'nowrap',
			}}
		>
			{isAuthenticated ? label : 'Sign in'}
		</button>
	)
}

// ---------------------------------------------------------------------------
// Settings Panel
// ---------------------------------------------------------------------------

interface SettingsPanelProps {
	syncUrl: string | null
	onChangeServer: (newUrl: string | null) => void
	onFactoryReset: () => void
	onClose: () => void
}

function SettingsPanel({ syncUrl, onChangeServer, onFactoryReset, onClose }: SettingsPanelProps) {
	const [editing, setEditing] = useState(false)
	const [newUrl, setNewUrl] = useState(syncUrl ?? '')
	const [testing, setTesting] = useState(false)
	const [testResult, setTestResult] = useState<'success' | 'failure' | null>(null)
	const [showResetConfirm, setShowResetConfirm] = useState(false)
	const [showChangeConfirm, setShowChangeConfirm] = useState(false)

	const handleTestConnection = async () => {
		const url = editing ? newUrl.trim() : syncUrl
		if (!url) return
		setTesting(true)
		setTestResult(null)
		const ok = await testConnection(url)
		setTestResult(ok ? 'success' : 'failure')
		setTesting(false)
	}

	const handleSaveUrl = () => {
		const trimmed = newUrl.trim()
		if (trimmed === syncUrl) {
			setEditing(false)
			return
		}
		// If there's existing data and the URL is changing, warn about data isolation
		setShowChangeConfirm(true)
	}

	const confirmChangeServer = (keepData: boolean) => {
		setShowChangeConfirm(false)
		if (keepData) {
			onChangeServer(newUrl.trim() || null)
		} else {
			// Factory reset + change server
			// Store the new URL so it's picked up after reload
			if (newUrl.trim()) {
				localStorage.setItem('kora-sync-url', newUrl.trim())
				localStorage.setItem('kora-sync-configured', 'true')
			}
			onFactoryReset()
		}
	}

	const handleDisconnect = () => {
		onChangeServer(null)
	}

	const handleConnect = () => {
		setEditing(true)
		setNewUrl('')
	}

	return (
		<div
			style={{
				marginBottom: '24px',
				borderRadius: '8px',
				border: '1px solid #1f2937',
				background: '#111827',
				overflow: 'hidden',
			}}
		>
			{/* Server URL section */}
			<div style={{ padding: '16px' }}>
				<div
					style={{
						display: 'flex',
						justifyContent: 'space-between',
						alignItems: 'flex-start',
						marginBottom: '12px',
					}}
				>
					<p style={{ fontSize: '14px', fontWeight: '500', color: '#d1d5db' }}>Sync Server</p>
					<button
						onClick={onClose}
						style={{
							fontSize: '12px',
							color: '#6b7280',
							background: 'none',
							border: 'none',
							cursor: 'pointer',
						}}
					>
						Close
					</button>
				</div>

				{editing ? (
					<div>
						<input
							type="text"
							value={newUrl}
							onChange={(e) => {
								setNewUrl(e.target.value)
								setTestResult(null)
							}}
							placeholder="wss://your-server.example.com/kora-sync"
							style={{
								width: '100%',
								borderRadius: '6px',
								border: '1px solid #374151',
								background: '#0a0a0a',
								padding: '8px 12px',
								color: '#f3f4f6',
								outline: 'none',
								fontSize: '13px',
								boxSizing: 'border-box',
								marginBottom: '8px',
							}}
						/>
						<div style={{ display: 'flex', gap: '8px' }}>
							<button
								onClick={handleSaveUrl}
								disabled={!newUrl.trim()}
								style={btnStyle('#4f46e5', !newUrl.trim())}
							>
								Save
							</button>
							<button
								onClick={handleTestConnection}
								disabled={testing || !newUrl.trim()}
								style={btnStyle('#374151', testing || !newUrl.trim())}
							>
								{testing ? 'Testing...' : 'Test'}
							</button>
							<button
								onClick={() => {
									setEditing(false)
									setTestResult(null)
								}}
								style={btnStyle('#374151', false)}
							>
								Cancel
							</button>
						</div>
					</div>
				) : (
					<div>
						<p
							style={{
								fontSize: '13px',
								color: '#9ca3af',
								marginBottom: '8px',
								wordBreak: 'break-all',
							}}
						>
							{syncUrl ?? 'Not connected — running in local-only mode'}
						</p>
						<div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
							{syncUrl ? (
								<>
									<button
										onClick={() => {
											setEditing(true)
											setNewUrl(syncUrl)
										}}
										style={btnStyle('#374151', false)}
									>
										Change URL
									</button>
									<button
										onClick={handleTestConnection}
										disabled={testing}
										style={btnStyle('#374151', testing)}
									>
										{testing ? 'Testing...' : 'Test Connection'}
									</button>
									<button onClick={handleDisconnect} style={btnStyle('#7f1d1d', false, '#ef4444')}>
										Disconnect
									</button>
								</>
							) : (
								<button onClick={handleConnect} style={btnStyle('#4f46e5', false)}>
									Connect to Server
								</button>
							)}
						</div>
					</div>
				)}

				{/* Test result */}
				{testResult && (
					<p
						style={{
							fontSize: '12px',
							marginTop: '8px',
							color: testResult === 'success' ? '#34d399' : '#fbbf24',
						}}
					>
						{testResult === 'success'
							? 'Connection successful'
							: 'Server unreachable — it may be down temporarily'}
					</p>
				)}
			</div>

			{/* Danger zone */}
			<div style={{ padding: '12px 16px', borderTop: '1px solid #1f2937', background: '#0a0a0a' }}>
				{showResetConfirm ? (
					<div>
						<div
							style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', marginBottom: '8px' }}
						>
							<AlertTriangle
								style={{
									width: '16px',
									height: '16px',
									color: '#ef4444',
									flexShrink: 0,
									marginTop: '1px',
								}}
							/>
							<p style={{ fontSize: '13px', color: '#fca5a5' }}>
								This will delete all local data and reset the app to its initial state. This cannot
								be undone.
							</p>
						</div>
						<div style={{ display: 'flex', gap: '8px' }}>
							<button onClick={onFactoryReset} style={btnStyle('#7f1d1d', false, '#ef4444')}>
								Confirm Reset
							</button>
							<button onClick={() => setShowResetConfirm(false)} style={btnStyle('#374151', false)}>
								Cancel
							</button>
						</div>
					</div>
				) : (
					<button
						onClick={() => setShowResetConfirm(true)}
						style={{
							fontSize: '13px',
							color: '#6b7280',
							background: 'none',
							border: 'none',
							cursor: 'pointer',
						}}
					>
						Reset app (clear all local data)
					</button>
				)}
			</div>

			{/* Server change confirmation dialog */}
			{showChangeConfirm && (
				<div
					style={{
						position: 'fixed',
						inset: 0,
						background: 'rgba(0,0,0,0.7)',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						zIndex: 100,
					}}
				>
					<div
						style={{
							maxWidth: '420px',
							width: '100%',
							margin: '0 16px',
							borderRadius: '12px',
							border: '1px solid #374151',
							background: '#111827',
							padding: '24px',
						}}
					>
						<div
							style={{
								display: 'flex',
								gap: '12px',
								alignItems: 'flex-start',
								marginBottom: '16px',
							}}
						>
							<AlertTriangle
								style={{
									width: '20px',
									height: '20px',
									color: '#fbbf24',
									flexShrink: 0,
									marginTop: '2px',
								}}
							/>
							<div>
								<p
									style={{
										fontSize: '15px',
										fontWeight: '500',
										color: '#f3f4f6',
										marginBottom: '8px',
									}}
								>
									Changing sync servers
								</p>
								<p style={{ fontSize: '13px', color: '#9ca3af', lineHeight: '1.6' }}>
									Existing local data was created for the current server. Keeping it and connecting
									to a different server may sync this data to the wrong place.
								</p>
							</div>
						</div>
						<div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
							<button
								onClick={() => confirmChangeServer(false)}
								style={{
									width: '100%',
									padding: '10px',
									borderRadius: '8px',
									border: '1px solid #374151',
									background: '#4f46e5',
									color: 'white',
									fontSize: '14px',
									cursor: 'pointer',
									fontWeight: '500',
								}}
							>
								Clear data and switch (recommended)
							</button>
							<button
								onClick={() => confirmChangeServer(true)}
								style={{
									width: '100%',
									padding: '10px',
									borderRadius: '8px',
									border: '1px solid #374151',
									background: '#1f2937',
									color: '#9ca3af',
									fontSize: '14px',
									cursor: 'pointer',
								}}
							>
								Keep data and switch
							</button>
							<button
								onClick={() => setShowChangeConfirm(false)}
								style={{
									width: '100%',
									padding: '10px',
									borderRadius: '8px',
									border: 'none',
									background: 'transparent',
									color: '#6b7280',
									fontSize: '14px',
									cursor: 'pointer',
								}}
							>
								Cancel
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	)
}

function btnStyle(bg: string, disabled: boolean, color = '#d1d5db'): React.CSSProperties {
	return {
		fontSize: '13px',
		color,
		background: bg,
		border: 'none',
		borderRadius: '6px',
		padding: '6px 12px',
		cursor: disabled ? 'default' : 'pointer',
		opacity: disabled ? 0.5 : 1,
	}
}

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
	return (
		<div
			style={{
				borderRadius: '8px',
				border: '1px solid #1f2937',
				background: '#111827',
				padding: '16px',
			}}
		>
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

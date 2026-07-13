<script lang="ts">
	import { createAuthStore } from '@korajs/auth/svelte'
	import { createSyncStatusStore } from '@korajs/svelte'
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
	} from '@lucide/svelte'
	import { createTodosStores } from './modules/todos/useTodos'

	type Filter = 'all' | 'active' | 'completed'

	const syncStatus = createSyncStatusStore()
	const auth = createAuthStore()
	const todos = createTodosStores()
	const { allTodos, activeTodos, completedTodos, addTodo, toggleTodo, deleteTodo } = todos

	let filter = $state<Filter>('all')
	let input = $state('')

	const filteredTodos = $derived(
		filter === 'active'
			? $activeTodos
			: filter === 'completed'
				? $completedTodos
				: $allTodos,
	)

	const syncBadge = $derived.by(() => {
		const s = $syncStatus.status
		const pending = $syncStatus.pendingOperations ?? 0
		const map: Record<string, { icon: typeof Wifi; color: string; label: string }> = {
			connected: { icon: Wifi, color: 'text-emerald-400', label: 'Connected' },
			syncing: { icon: Wifi, color: 'text-amber-400', label: 'Syncing' },
			synced: { icon: Wifi, color: 'text-emerald-400', label: 'Synced' },
			offline: { icon: WifiOff, color: 'text-gray-500', label: 'Offline' },
			error: { icon: AlertCircle, color: 'text-red-400', label: 'Error' },
		}
		return { ...(map[s] ?? map.offline), pending }
	})

	function handleSubmit(event: SubmitEvent): void {
		event.preventDefault()
		const title = input.trim()
		if (!title) return
		addTodo.mutate({ title })
		input = ''
	}

	function clearCompleted(): void {
		for (const todo of $completedTodos) {
			deleteTodo.mutate(todo.id)
		}
	}

	function emptyMessage(f: Filter): string {
		if (f === 'all') return 'No tasks yet. Add one above!'
		if (f === 'active') return 'All caught up! No active tasks.'
		return 'No completed tasks yet.'
	}
</script>

<div class="min-h-screen bg-gray-950 text-gray-100">
	<div class="mx-auto max-w-2xl px-4 py-12">
		<div class="mb-8 flex items-center justify-between">
			<div class="flex items-center gap-3">
				<ClipboardList class="h-8 w-8 text-indigo-400" />
				<h1 class="text-2xl font-bold">My Tasks</h1>
			</div>
			<div class="flex items-center gap-2">
				<div class="flex items-center gap-2 rounded-full bg-gray-800 px-3 py-1.5 text-sm">
					<svelte:component this={syncBadge.icon} class="h-4 w-4 {syncBadge.color}" />
					<span class={syncBadge.color}>{syncBadge.label}</span>
					{#if syncBadge.pending > 0}
						<span class="rounded-full bg-gray-700 px-2 py-0.5 text-xs text-gray-400">
							{syncBadge.pending} pending
						</span>
					{/if}
				</div>
				{#if $auth.isAuthenticated}
					<button
						type="button"
						class="max-w-44 truncate rounded-full border border-gray-700 bg-gray-900 px-3 py-1.5 text-sm text-gray-300"
						onclick={() => $auth.signOut()}
					>
						{$auth.user?.email || 'Sign out'}
					</button>
				{:else}
					<button
						type="button"
						class="rounded-full border border-gray-700 bg-gray-900 px-3 py-1.5 text-sm text-gray-300"
						onclick={() => $auth.signInWithOAuth('google')}
					>
						Sign in
					</button>
				{/if}
			</div>
		</div>

		{#if $auth.error}
			<div class="mb-4 rounded-lg border border-red-400/30 px-3 py-2 text-sm text-red-300">
				{$auth.error}
			</div>
		{/if}

		<div class="mb-8 grid grid-cols-3 gap-4">
			<div class="rounded-lg border border-gray-800 bg-gray-900 p-4">
				<p class="text-sm text-gray-500">Total</p>
				<p class="text-2xl font-bold text-gray-300">{$allTodos.length}</p>
			</div>
			<div class="rounded-lg border border-gray-800 bg-gray-900 p-4">
				<p class="text-sm text-gray-500">Remaining</p>
				<p class="text-2xl font-bold text-amber-400">{$activeTodos.length}</p>
			</div>
			<div class="rounded-lg border border-gray-800 bg-gray-900 p-4">
				<p class="text-sm text-gray-500">Done</p>
				<p class="text-2xl font-bold text-emerald-400">{$completedTodos.length}</p>
			</div>
		</div>

		<form class="mb-8 flex gap-3" onsubmit={handleSubmit}>
			<input
				bind:value={input}
				type="text"
				placeholder="What needs to be done?"
				class="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-4 py-3 text-gray-100 placeholder-gray-500 outline-none focus:border-indigo-500"
			/>
			<button
				type="submit"
				disabled={!input.trim()}
				class="flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-3 font-medium text-white disabled:opacity-50"
			>
				<Plus class="h-4 w-4" />
				Add
			</button>
		</form>

		<div class="mb-6 flex gap-2">
			{#each ['all', 'active', 'completed'] as const as f}
				<button
					type="button"
					class="rounded-lg px-4 py-2 text-sm font-medium {filter === f
						? 'bg-indigo-600 text-white'
						: 'bg-gray-800 text-gray-400'}"
					onclick={() => (filter = f)}
				>
					{f.charAt(0).toUpperCase() + f.slice(1)}
				</button>
			{/each}
		</div>

		<div class="space-y-2">
			{#if filteredTodos.length === 0}
				<div class="rounded-lg border border-dashed border-gray-800 py-12 text-center text-gray-600">
					{emptyMessage(filter)}
				</div>
			{:else}
				{#each filteredTodos as todo (todo.id)}
					<div
						class="group flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-900 px-4 py-3"
					>
						<button
							type="button"
							class="text-gray-500 hover:text-indigo-400"
							onclick={() => toggleTodo.mutate(todo.id, { completed: !todo.completed })}
						>
							{#if todo.completed}
								<CheckCircle2 class="h-5 w-5 text-emerald-400" />
							{:else}
								<Circle class="h-5 w-5" />
							{/if}
						</button>
						<span class="flex-1 {todo.completed ? 'line-through text-gray-500' : ''}">
							{String(todo.title)}
						</span>
						<button
							type="button"
							class="text-gray-600 opacity-0 group-hover:opacity-100 hover:text-red-400"
							onclick={() => deleteTodo.mutate(todo.id)}
						>
							<Trash2 class="h-4 w-4" />
						</button>
					</div>
				{/each}
			{/if}
		</div>

		<p class="mt-12 text-center text-xs text-gray-700">Powered by Kora — offline-first, real-time sync</p>
	</div>
</div>

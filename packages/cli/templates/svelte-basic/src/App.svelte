<script lang="ts">
import { useFormDraft } from '@korajs/svelte'
import { onDestroy, onMount } from 'svelte'
import { createTodosStores } from './modules/todos/useTodos'

type Filter = 'all' | 'active' | 'completed'

const { allTodos, activeTodos, completedTodos, addTodo, toggleTodo, deleteTodo } =
	createTodosStores()

// biome-ignore lint/style/useConst: reassigned in the markup, which Biome does not see
let filter = $state<Filter>('all')
// What is typed in the new-task field survives the reload a new version of the app asks for
// (opt-in, only the listed field). Never draft passwords or sensitive answers.
const draft = useFormDraft(
	'new-todo',
	{ title: '' },
	{ fields: ['title'], collection: 'todos' },
)
onMount(draft.restore)
onDestroy(draft.destroy)
const draftField = draft.field

const filteredTodos = $derived(
	filter === 'active' ? $activeTodos : filter === 'completed' ? $completedTodos : $allTodos,
)

function handleSubmit(event: SubmitEvent): void {
	event.preventDefault()
	const title = $draft.title.trim()
	if (!title) return
	// The draft is cleared once the write is stored; a refused write keeps it.
	addTodo
		.mutateAsync({ title })
		.then(() => draft.clear())
		.catch(() => {})
}

function clearCompleted(): void {
	for (const todo of $completedTodos) {
		deleteTodo.mutate(todo.id)
	}
}

function formatTime(timestamp: number): string {
	const date = new Date(timestamp)
	const now = new Date()
	if (date.toDateString() === now.toDateString()) {
		return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
	}
	return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
</script>

<div class="app">
	<div class="header">
		<h1>My Tasks</h1>
	</div>

	<div class="stats">
		<div class="stat-card">
			<div class="label">Total</div>
			<div class="value muted">{$allTodos.length}</div>
		</div>
		<div class="stat-card">
			<div class="label">Remaining</div>
			<div class="value warning">{$activeTodos.length}</div>
		</div>
		<div class="stat-card">
			<div class="label">Done</div>
			<div class="value success">{$completedTodos.length}</div>
		</div>
	</div>

	<form class="add-form" onsubmit={handleSubmit}>
		<input bind:value={$draft.title} use:draftField={'title'} type="text" placeholder="What needs to be done?" />
		<button type="submit" disabled={!$draft.title.trim()}>Add</button>
	</form>

	<div class="filters">
		{#each ['all', 'active', 'completed'] as const as f}
			<button
				type="button"
				class="filter-btn {filter === f ? 'active' : ''}"
				onclick={() => (filter = f)}
			>
				{f.charAt(0).toUpperCase() + f.slice(1)}
				<span class="badge">
					{f === 'all'
						? $allTodos.length
						: f === 'active'
							? $activeTodos.length
							: $completedTodos.length}
				</span>
			</button>
		{/each}
	</div>

	<div class="todo-list">
		{#if filteredTodos.length === 0}
			<div class="empty-state">
				{#if filter === 'all'}
					No tasks yet. Add one above!
				{:else if filter === 'active'}
					All caught up! No active tasks.
				{:else}
					No completed tasks yet.
				{/if}
			</div>
		{:else}
			{#each filteredTodos as todo (todo.id)}
				<div class="todo-item">
					<button
						type="button"
						class="toggle {todo.completed ? 'checked' : ''}"
						onclick={() => toggleTodo.mutate(todo.id, { completed: !todo.completed })}
					>
						{todo.completed ? '✓' : ''}
					</button>
					<span class="title {todo.completed ? 'done' : ''}">{String(todo.title)}</span>
					{#if todo.createdAt}
						<span class="time">{formatTime(Number(todo.createdAt))}</span>
					{/if}
					<button type="button" class="delete-btn" onclick={() => deleteTodo.mutate(todo.id)}>
						×
					</button>
				</div>
			{/each}
		{/if}
	</div>

	{#if $allTodos.length > 0}
		<div class="footer">
			<span>{$activeTodos.length} item{$activeTodos.length !== 1 ? 's' : ''} left</span>
			{#if $completedTodos.length > 0}
				<button type="button" onclick={clearCompleted}>Clear completed</button>
			{/if}
		</div>
	{/if}

	<p class="branding">Powered by Kora — offline-first</p>
</div>

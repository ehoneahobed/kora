<script lang="ts">
import { useFormDraft } from '@korajs/svelte'
import { CheckCircle2, Circle, ClipboardList, Plus, Trash2 } from '@lucide/svelte'
import { onDestroy, onMount } from 'svelte'
import OfflineBadge from './OfflineBadge.svelte'
import { createTodosStores } from './modules/todos/useTodos'

type Filter = 'all' | 'active' | 'completed'

const { allTodos, activeTodos, completedTodos, addTodo, toggleTodo, deleteTodo } =
	createTodosStores()

// biome-ignore lint/style/useConst: reassigned in the markup, which Biome does not see
let filter = $state<Filter>('all')
// What is typed in the new-task field survives the reload a new version of the app asks for
// (opt-in, only the listed field). Never draft passwords or sensitive answers.
const draft = useFormDraft('new-todo', { title: '' }, { fields: ['title'], collection: 'todos' })
onMount(draft.restore)
onDestroy(draft.destroy)
const draftField = draft.field

const filteredTodos = $derived(
	filter === 'active' ? $activeTodos : filter === 'completed' ? $completedTodos : $allTodos,
)

// One submit at a time (Enter pressed twice inserts once), and the field is cleared only if
// it still holds what was submitted: text typed for the next task meanwhile is kept.
let submitting = false
function handleSubmit(event: SubmitEvent): void {
	event.preventDefault()
	const submitted = $draft.title
	const title = submitted.trim()
	if (!title || submitting) return
	submitting = true
	// The draft is cleared once the write is stored; a refused write keeps it.
	addTodo
		.mutateAsync({ title })
		.then(() => {
			if ($draft.title === submitted) draft.clear()
		})
		.catch(() => {})
		.finally(() => {
			submitting = false
		})
}
</script>

<div class="min-h-screen bg-gray-950 text-gray-100">
	<div class="mx-auto max-w-2xl px-4 py-12">
		<div class="mb-8 flex items-center justify-between">
			<div class="flex items-center gap-3">
				<ClipboardList class="h-8 w-8 text-indigo-400" />
				<h1 class="text-2xl font-bold">My Tasks</h1>
			</div>
			<OfflineBadge />
		</div>

		<form class="mb-8 flex gap-3" onsubmit={handleSubmit}>
			<input
				bind:value={$draft.title}
				use:draftField={'title'}
				type="text"
				placeholder="What needs to be done?"
				class="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-4 py-3 text-gray-100 placeholder-gray-500 outline-none focus:border-indigo-500"
			/>
			<button
				type="submit"
				disabled={!$draft.title.trim()}
				class="flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-3 font-medium text-white disabled:opacity-50"
			>
				<Plus class="h-4 w-4" />
				Add
			</button>
		</form>

		<div class="space-y-2">
			{#each filteredTodos as todo (todo.id)}
				<div class="group flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-900 px-4 py-3">
					<button
						type="button"
						onclick={() => toggleTodo.mutate(todo.id, { completed: !todo.completed })}
					>
						{#if todo.completed}
							<CheckCircle2 class="h-5 w-5 text-emerald-400" />
						{:else}
							<Circle class="h-5 w-5 text-gray-500" />
						{/if}
					</button>
					<span class="flex-1 {todo.completed ? 'line-through text-gray-500' : ''}">
						{String(todo.title)}
					</span>
					<button type="button" onclick={() => deleteTodo.mutate(todo.id)}>
						<Trash2 class="h-4 w-4 text-gray-600 hover:text-red-400" />
					</button>
				</div>
			{/each}
		</div>

		<p class="mt-12 text-center text-xs text-gray-700">Powered by Kora — offline-first</p>
	</div>
</div>

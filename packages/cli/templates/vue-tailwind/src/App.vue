<script setup lang="ts">
import { CheckCircle2, Circle, ClipboardList, Loader2, Plus, Trash2 } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import { useTodos } from './modules/todos/useTodos'

type Filter = 'all' | 'active' | 'completed'

const { allTodos, activeTodos, completedTodos, addTodo, toggleTodo, deleteTodo } = useTodos()

const filter = ref<Filter>('all')
const input = ref('')

const filteredTodos = computed(() => {
	if (filter.value === 'active') return activeTodos.value
	if (filter.value === 'completed') return completedTodos.value
	return allTodos.value
})

function handleSubmit(): void {
	const title = input.value.trim()
	if (!title) return
	addTodo.mutate({ title })
	input.value = ''
}

function clearCompleted(): void {
	for (const todo of completedTodos.value) {
		deleteTodo.mutate(todo.id)
	}
}

function emptyMessage(f: Filter): string {
	if (f === 'all') return 'No tasks yet. Add one above!'
	if (f === 'active') return 'All caught up! No active tasks.'
	return 'No completed tasks yet.'
}
</script>

<template>
	<div class="min-h-screen bg-gray-950 text-gray-100">
		<div class="mx-auto max-w-2xl px-4 py-12">
			<div class="mb-8 flex items-center gap-3">
				<ClipboardList class="h-8 w-8 text-indigo-400" />
				<h1 class="text-2xl font-bold">My Tasks</h1>
			</div>

			<div class="mb-8 grid grid-cols-3 gap-4">
				<div class="rounded-lg border border-gray-800 bg-gray-900 p-4">
					<p class="text-sm text-gray-500">Total</p>
					<p class="text-2xl font-bold text-gray-300">{{ allTodos.length }}</p>
				</div>
				<div class="rounded-lg border border-gray-800 bg-gray-900 p-4">
					<p class="text-sm text-gray-500">Remaining</p>
					<p class="text-2xl font-bold text-amber-400">{{ activeTodos.length }}</p>
				</div>
				<div class="rounded-lg border border-gray-800 bg-gray-900 p-4">
					<p class="text-sm text-gray-500">Done</p>
					<p class="text-2xl font-bold text-emerald-400">{{ completedTodos.length }}</p>
				</div>
			</div>

			<form class="mb-8 flex gap-3" @submit.prevent="handleSubmit">
				<input
					v-model="input"
					type="text"
					placeholder="What needs to be done?"
					class="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-4 py-3 text-gray-100 placeholder-gray-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
				/>
				<button
					type="submit"
					:disabled="addTodo.isLoading.value || !input.trim()"
					class="flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-3 font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
				>
					<Loader2 v-if="addTodo.isLoading.value" class="h-4 w-4 animate-spin" />
					<Plus v-else class="h-4 w-4" />
					Add
				</button>
			</form>

			<div class="mb-6 flex gap-2">
				<button
					v-for="f in (['all', 'active', 'completed'] as const)"
					:key="f"
					type="button"
					:class="[
						'flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition',
						filter === f
							? 'bg-indigo-600 text-white'
							: 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200',
					]"
					@click="filter = f"
				>
					{{ f.charAt(0).toUpperCase() + f.slice(1) }}
				</button>
			</div>

			<div class="space-y-2">
				<div
					v-if="filteredTodos.length === 0"
					class="rounded-lg border border-dashed border-gray-800 py-12 text-center text-gray-600"
				>
					{{ emptyMessage(filter) }}
				</div>
				<template v-else>
					<div
						v-for="todo in filteredTodos"
						:key="todo.id"
						class="group flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-900 px-4 py-3"
					>
						<button
							type="button"
							class="shrink-0 text-gray-500 hover:text-indigo-400"
							@click="toggleTodo.mutate(todo.id, { completed: !todo.completed })"
						>
							<CheckCircle2 v-if="todo.completed" class="h-5 w-5 text-emerald-400" />
							<Circle v-else class="h-5 w-5" />
						</button>
						<span :class="['flex-1', todo.completed ? 'line-through text-gray-500' : '']">
							{{ String(todo.title) }}
						</span>
						<button
							type="button"
							class="text-gray-600 opacity-0 group-hover:opacity-100 hover:text-red-400"
							@click="deleteTodo.mutate(todo.id)"
						>
							<Trash2 class="h-4 w-4" />
						</button>
					</div>
				</template>
			</div>

			<p class="mt-12 text-center text-xs text-gray-700">Powered by Kora — offline-first</p>
		</div>
	</div>
</template>

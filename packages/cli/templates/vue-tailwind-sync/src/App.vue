<script setup lang="ts">
import { useAuth, useAuthStatus, useCurrentUser } from '@korajs/auth/vue'
import { useApp, useFormDraft, useSyncStatus } from '@korajs/vue'
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
} from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'
import { useTodos } from './modules/todos/useTodos'

type Filter = 'all' | 'active' | 'completed'

const { allTodos, activeTodos, completedTodos, addTodo, toggleTodo, deleteTodo } = useTodos()
const syncStatus = useSyncStatus()
const { user, isAuthenticated, signInWithOAuth, signOut, error } = useAuth()

const filter = ref<Filter>('all')
const app = useApp()
const currentUser = useCurrentUser()
const authStatus = useAuthStatus()
// Drafts belong to the signed-in user. While the session loads the user is unknown
// (undefined): no draft is restored, saved or cleared until it is known.
const draftUser = computed(() =>
	authStatus.isLoading ? undefined : (currentUser.value?.id ?? null),
)
watch(draftUser, (next, previous) => {
	// Cleared when a known user changes (sign-out, another account), never on the first load
	// of the session.
	if (next !== undefined && previous !== undefined && next !== previous) clearFormDrafts(app)
})
async function signOutAndClearDrafts(): Promise<void> {
	clearFormDrafts(app)
	await signOut()
}
// What is typed in the new-task field survives the reload a new version of the app asks for
// (opt-in, only the listed field). Never draft passwords or sensitive answers.
const draft = useFormDraft(
	'new-todo',
	{ title: '' },
	{ fields: ['title'], collection: 'todos', userId: draftUser },
)

const filteredTodos = computed(() => {
	if (filter.value === 'active') return activeTodos.value
	if (filter.value === 'completed') return completedTodos.value
	return allTodos.value
})

const syncBadge = computed(() => {
	const status = syncStatus.value
	const s = status.status
	const pending = status.pendingOperations ?? 0
	const map: Record<string, { icon: typeof Wifi; color: string; label: string }> = {
		connected: { icon: Wifi, color: 'text-emerald-400', label: 'Connected' },
		syncing: { icon: Wifi, color: 'text-amber-400', label: 'Syncing' },
		synced: { icon: Wifi, color: 'text-emerald-400', label: 'Synced' },
		offline: { icon: WifiOff, color: 'text-gray-500', label: 'Offline' },
		error: { icon: AlertCircle, color: 'text-red-400', label: 'Error' },
	}
	return { ...(map[s] ?? map.offline), pending }
})

// One submit at a time (Enter pressed twice inserts once), and the field is cleared only if
// it still holds what was submitted: text typed for the next task meanwhile is kept.
let submitting = false
function handleSubmit(): void {
	const submitted = draft.values.title
	const title = submitted.trim()
	if (!title || submitting) return
	submitting = true
	// The draft is cleared once the write is stored; a refused write keeps it.
	addTodo
		.mutateAsync({ title })
		.then(() => {
			if (draft.values.title === submitted) draft.clear()
		})
		.catch(() => {})
		.finally(() => {
			submitting = false
		})
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

function formatTime(timestamp: number): string {
	const date = new Date(timestamp)
	const now = new Date()
	if (date.toDateString() === now.toDateString()) {
		return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
	}
	return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
</script>

<template>
	<div class="min-h-screen bg-gray-950 text-gray-100">
		<div class="mx-auto max-w-2xl px-4 py-12">
			<div class="mb-8 flex items-center justify-between">
				<div class="flex items-center gap-3">
					<ClipboardList class="h-8 w-8 text-indigo-400" />
					<h1 class="text-2xl font-bold">My Tasks</h1>
				</div>
				<div class="flex items-center gap-2">
					<div class="flex items-center gap-2 rounded-full bg-gray-800 px-3 py-1.5 text-sm">
						<component :is="syncBadge.icon" :class="['h-4 w-4', syncBadge.color]" />
						<span :class="syncBadge.color">{{ syncBadge.label }}</span>
						<span
							v-if="syncBadge.pending > 0"
							class="rounded-full bg-gray-700 px-2 py-0.5 text-xs text-gray-400"
						>
							{{ syncBadge.pending }} pending
						</span>
					</div>
					<button
						v-if="isAuthenticated"
						type="button"
						class="max-w-44 truncate rounded-full border border-gray-700 bg-gray-900 px-3 py-1.5 text-sm text-gray-300 transition hover:border-gray-600"
						@click="signOutAndClearDrafts()"
					>
						{{ user?.email || 'Sign out' }}
					</button>
					<button
						v-else
						type="button"
						class="rounded-full border border-gray-700 bg-gray-900 px-3 py-1.5 text-sm text-gray-300 transition hover:border-gray-600"
						@click="signInWithOAuth('google')"
					>
						Sign in
					</button>
				</div>
			</div>

			<div v-if="error" class="mb-4 rounded-lg border border-red-400/30 px-3 py-2 text-sm text-red-300">
				{{ error }}
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
					v-model="draft.values.title"
					:ref="draft.fieldRef('title')"
					type="text"
					placeholder="What needs to be done?"
					class="flex-1 rounded-lg border border-gray-700 bg-gray-900 px-4 py-3 text-gray-100 placeholder-gray-500 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
				/>
				<button
					type="submit"
					:disabled="addTodo.isLoading.value || !draft.values.title.trim()"
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
					<span
						:class="[
							'rounded-full px-2 py-0.5 text-xs',
							filter === f ? 'bg-indigo-500 text-white' : 'bg-gray-700 text-gray-400',
						]"
					>
						{{
							f === 'all'
								? allTodos.length
								: f === 'active'
									? activeTodos.length
									: completedTodos.length
						}}
					</span>
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
						class="group flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-900 px-4 py-3 transition hover:border-gray-700"
					>
					<button
						type="button"
						class="shrink-0 text-gray-500 transition hover:text-indigo-400"
						@click="toggleTodo.mutate(todo.id, { completed: !todo.completed })"
					>
						<CheckCircle2 v-if="todo.completed" class="h-5 w-5 text-emerald-400" />
						<Circle v-else class="h-5 w-5" />
					</button>
					<span
						:class="[
							'flex-1',
							todo.completed ? 'text-gray-500 line-through' : 'text-gray-100',
						]"
					>
						{{ String(todo.title) }}
					</span>
					<span v-if="todo.createdAt" class="text-xs text-gray-600">
						{{ formatTime(Number(todo.createdAt)) }}
					</span>
					<button
						type="button"
						class="shrink-0 text-gray-600 opacity-0 transition hover:text-red-400 group-hover:opacity-100"
						@click="deleteTodo.mutate(todo.id)"
					>
						<Trash2 class="h-4 w-4" />
					</button>
					</div>
				</template>
			</div>

			<div
				v-if="allTodos.length > 0"
				class="mt-6 flex items-center justify-between text-sm text-gray-500"
			>
				<span>{{ activeTodos.length }} item{{ activeTodos.length !== 1 ? 's' : '' }} left</span>
				<button
					v-if="completedTodos.length > 0"
					type="button"
					class="text-gray-500 transition hover:text-gray-300"
					@click="clearCompleted"
				>
					Clear completed
				</button>
			</div>

			<p class="mt-12 text-center text-xs text-gray-700">
				Powered by Kora — offline-first, real-time sync
			</p>
		</div>
	</div>
</template>

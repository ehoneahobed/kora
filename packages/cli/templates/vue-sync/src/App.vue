<script setup lang="ts">
import { useAuth, useCurrentUser } from '@korajs/auth/vue'
import { useApp, useFormDraft, useSyncStatus } from '@korajs/vue'
import { clearFormDrafts } from 'korajs'
import { computed, ref, watch } from 'vue'
import { useTodos } from './modules/todos/useTodos'

type Filter = 'all' | 'active' | 'completed'

const { allTodos, activeTodos, completedTodos, addTodo, toggleTodo, deleteTodo } = useTodos()
const syncStatus = useSyncStatus()
const { user, isAuthenticated, signInWithOAuth, signOut, error } = useAuth()

const filter = ref<Filter>('all')
const app = useApp()
const currentUser = useCurrentUser()
// Drafts belong to the signed-in user: cleared on sign-out and when the user changes.
watch(
	() => currentUser.value?.id ?? null,
	(next, previous) => {
		if (next !== previous) clearFormDrafts(app)
	},
)
async function signOutAndClearDrafts(): Promise<void> {
	clearFormDrafts(app)
	await signOut()
}
// What is typed in the new-task field survives the reload a new version of the app asks for
// (opt-in, only the listed field). Never draft passwords or sensitive answers.
const draft = useFormDraft(
	'new-todo',
	{ title: '' },
	{ fields: ['title'], collection: 'todos', userId: currentUser.value?.id ?? null },
)

const filteredTodos = computed(() => {
	if (filter.value === 'active') return activeTodos.value
	if (filter.value === 'completed') return completedTodos.value
	return allTodos.value
})

function handleSubmit(): void {
	const title = draft.values.title.trim()
	if (!title) return
	// The draft is cleared once the write is stored; a refused write keeps it.
	addTodo
		.mutateAsync({ title })
		.then(() => draft.clear())
		.catch(() => {})
}

function clearCompleted(): void {
	for (const todo of completedTodos.value) {
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

<template>
	<div class="app">
		<div class="header">
			<h1>My Tasks</h1>
			<div class="header-actions">
				<div class="sync-badge">
					<span :class="['sync-dot', syncStatus.status]" />
					<span>{{ syncStatus.status }}</span>
				</div>
				<button v-if="isAuthenticated" type="button" class="auth-button" @click="signOutAndClearDrafts()">
					{{ user?.email || 'Sign out' }}
				</button>
				<button v-else type="button" class="auth-button" @click="signInWithOAuth('google')">
					Sign in
				</button>
			</div>
		</div>

		<div v-if="error" class="auth-error">{{ error }}</div>

		<div class="stats">
			<div class="stat-card">
				<div class="label">Total</div>
				<div class="value muted">{{ allTodos.length }}</div>
			</div>
			<div class="stat-card">
				<div class="label">Remaining</div>
				<div class="value warning">{{ activeTodos.length }}</div>
			</div>
			<div class="stat-card">
				<div class="label">Done</div>
				<div class="value success">{{ completedTodos.length }}</div>
			</div>
		</div>

		<form class="add-form" @submit.prevent="handleSubmit">
			<input v-model="draft.values.title" :ref="draft.fieldRef('title')" type="text" placeholder="What needs to be done?" />
			<button type="submit" :disabled="!draft.values.title.trim()">Add</button>
		</form>

		<div class="filters">
			<button
				v-for="f in (['all', 'active', 'completed'] as const)"
				:key="f"
				type="button"
				:class="['filter-btn', { active: filter === f }]"
				@click="filter = f"
			>
				{{ f.charAt(0).toUpperCase() + f.slice(1) }}
				<span class="badge">
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

		<div class="todo-list">
			<div v-if="filteredTodos.length === 0" class="empty-state">
				<template v-if="filter === 'all'">No tasks yet. Add one above!</template>
				<template v-else-if="filter === 'active'">All caught up! No active tasks.</template>
				<template v-else>No completed tasks yet.</template>
			</div>
			<div v-for="todo in filteredTodos" v-else :key="todo.id" class="todo-item">
				<button
					type="button"
					:class="['toggle', { checked: todo.completed }]"
					@click="toggleTodo.mutate(todo.id, { completed: !todo.completed })"
				>
					{{ todo.completed ? '✓' : '' }}
				</button>
				<span :class="['title', { done: todo.completed }]">{{ String(todo.title) }}</span>
				<span v-if="todo.createdAt" class="time">{{ formatTime(Number(todo.createdAt)) }}</span>
				<button type="button" class="delete-btn" @click="deleteTodo.mutate(todo.id)">×</button>
			</div>
		</div>

		<div v-if="allTodos.length > 0" class="footer">
			<span>{{ activeTodos.length }} item{{ activeTodos.length !== 1 ? 's' : '' }} left</span>
			<button v-if="completedTodos.length > 0" type="button" @click="clearCompleted">
				Clear completed
			</button>
		</div>

		<p class="branding">Powered by Kora — offline-first, real-time sync</p>
	</div>
</template>

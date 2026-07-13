<script setup lang="ts">
import { useAuth } from '@korajs/auth/vue'
import { useSyncStatus } from '@korajs/vue'
import { computed, ref } from 'vue'
import { useTodos } from './modules/todos/useTodos'

type Filter = 'all' | 'active' | 'completed'

const { allTodos, activeTodos, completedTodos, addTodo, toggleTodo, deleteTodo } = useTodos()
const syncStatus = useSyncStatus()
const { user, isAuthenticated, signInWithOAuth, signOut, error } = useAuth()

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
				<button v-if="isAuthenticated" type="button" class="auth-button" @click="signOut()">
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
			<input v-model="input" type="text" placeholder="What needs to be done?" />
			<button type="submit" :disabled="!input.trim()">Add</button>
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

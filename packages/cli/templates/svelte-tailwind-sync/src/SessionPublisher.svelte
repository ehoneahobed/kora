<script lang="ts">
import { createAuthStore } from '@korajs/auth/svelte'
import { publishAuth } from './auth-state'

// Publishes the session to the screen (see auth-state.ts). Renders nothing.
const auth = createAuthStore()

$effect(() => {
	const current = $auth
	publishAuth({
		isLoading: current.isLoading,
		user: current.user ? { id: current.user.id, email: current.user.email } : null,
		isAuthenticated: current.isAuthenticated,
		error: current.error ?? null,
		signInWithOAuth: () => void current.signInWithOAuth('google'),
		signOut: current.signOut,
	})
})
</script>

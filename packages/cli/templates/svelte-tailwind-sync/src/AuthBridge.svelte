<script lang="ts">
import AuthProvider from '@korajs/auth/svelte/AuthProvider.svelte'
import { onMount } from 'svelte'
import SessionPublisher from './SessionPublisher.svelte'
import { authClient, completeOAuthCallbackFromLocation } from './auth'

// The sign-in client, mounted after the first paint. Everything that needs `@korajs/auth` lives
// behind this component so the task list does not carry it.
onMount(() => {
	void completeOAuthCallbackFromLocation().catch((callbackError) => {
		console.error('[Kora Auth] OAuth callback failed:', callbackError)
	})
})
</script>

<AuthProvider client={authClient}>
	<SessionPublisher />
</AuthProvider>

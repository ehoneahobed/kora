<script lang="ts">
import type { AuthClient } from '@korajs/auth'
import AuthProvider from '@korajs/auth/svelte/AuthProvider.svelte'
import type { KoraAppLike } from '@korajs/svelte'
import KoraProvider from '@korajs/svelte/KoraProvider.svelte'
import App from './App.svelte'

const { kora, authClient }: { kora: KoraAppLike; authClient: AuthClient } = $props()
</script>

<AuthProvider client={authClient}>
	{#snippet fallback()}
		<div>Restoring session...</div>
	{/snippet}

	<KoraProvider app={kora}>
		{#snippet fallback()}
			<div>Loading...</div>
		{/snippet}
		<App />
	</KoraProvider>
</AuthProvider>

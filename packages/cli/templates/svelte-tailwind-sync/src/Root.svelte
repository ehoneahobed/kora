<script lang="ts">
	import type { AuthClient } from '@korajs/auth'
	import type { KoraAppLike } from '@korajs/svelte'
	import AuthProvider from '@korajs/auth/svelte/AuthProvider.svelte'
	import KoraProvider from '@korajs/svelte/KoraProvider.svelte'
	import App from './App.svelte'

	let { kora, authClient }: { kora: KoraAppLike; authClient: AuthClient } = $props()
</script>

<AuthProvider client={authClient}>
	{#snippet fallback()}
		<div class="flex h-screen items-center justify-center bg-gray-950 text-gray-400">
			Restoring session...
		</div>
	{/snippet}

	<KoraProvider app={kora}>
		{#snippet fallback()}
			<div class="flex h-screen items-center justify-center bg-gray-950 text-gray-400">
				Loading...
			</div>
		{/snippet}
		<App />
	</KoraProvider>
</AuthProvider>

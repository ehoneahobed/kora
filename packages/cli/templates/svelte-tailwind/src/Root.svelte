<script lang="ts">
import type { KoraAppLike } from '@korajs/svelte'
import KoraProvider from '@korajs/svelte/KoraProvider.svelte'
import App from './App.svelte'

const { kora }: { kora: KoraAppLike } = $props()
</script>

<KoraProvider app={kora}>
	{#snippet fallback()}
		<div class="flex h-screen items-center justify-center bg-gray-950 text-gray-400">Loading...</div>
	{/snippet}
	<App />
</KoraProvider>

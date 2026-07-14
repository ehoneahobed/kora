<script lang="ts">
import type { KoraAppLike } from '@korajs/svelte'
import KoraProvider from '@korajs/svelte/KoraProvider.svelte'
import App from './App.svelte'

const { kora }: { kora: KoraAppLike } = $props()
</script>

<KoraProvider app={kora}>
	{#snippet fallback()}
		<div>Loading...</div>
	{/snippet}
	<App />
</KoraProvider>

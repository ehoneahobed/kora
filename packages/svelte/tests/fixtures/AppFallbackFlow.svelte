<script lang="ts">
	import type { KoraAppLike } from '../../src/types'
	import KoraProvider from '../../src/components/KoraProvider.svelte'

	interface Props {
		app: KoraAppLike
	}

	let { app }: Props = $props()
</script>

<KoraProvider {app}>
	{#snippet fallback()}
		<div data-testid="fallback">Loading...</div>
	{/snippet}
	<div data-testid="child">Loaded!</div>
</KoraProvider>

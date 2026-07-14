<script lang="ts">
import KoraProvider from '../../src/components/KoraProvider.svelte'
import type { KoraAppLike } from '../../src/types'

interface Props {
	app: KoraAppLike
}

const { app }: Props = $props()
</script>

<KoraProvider {app}>
	{#snippet fallback()}
		<div data-testid="fallback">Loading...</div>
	{/snippet}
	<div data-testid="child">Loaded!</div>
</KoraProvider>

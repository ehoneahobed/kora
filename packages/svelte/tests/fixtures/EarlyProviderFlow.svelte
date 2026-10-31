<script lang="ts">
import KoraProvider from '../../src/components/KoraProvider.svelte'
import type { KoraAppLike, KoraContextValue } from '../../src/types'
import ProviderProbe from './ProviderProbe.svelte'

const {
	app,
	waitForStorage = false,
	report,
}: {
	app: KoraAppLike
	waitForStorage?: boolean
	report: (context: KoraContextValue) => void
} = $props()
</script>

<KoraProvider {app} {waitForStorage}>
	{#snippet fallback()}
		<div>gate</div>
	{/snippet}
	<ProviderProbe {report} />
</KoraProvider>

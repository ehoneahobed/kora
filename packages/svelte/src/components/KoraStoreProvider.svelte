<script lang="ts">
	import type { KoraContextValue } from '../types'
	import KoraStoreBridge from './KoraStoreBridge.svelte'

	interface Props {
		store: KoraContextValue['store']
		syncEngine?: KoraContextValue['syncEngine']
		children?: import('svelte').Snippet
	}

	let { store, syncEngine = null, children }: Props = $props()
</script>

<KoraStoreBridge {store} {syncEngine}>
	{#if children}
		{@render children()}
	{/if}
</KoraStoreBridge>

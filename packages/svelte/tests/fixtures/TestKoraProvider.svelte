<script lang="ts">
import type { Store } from '@korajs/store'
import type { SyncEngine } from '@korajs/sync'
import KoraStoreBridge from '../../src/components/KoraStoreBridge.svelte'

interface Props {
	store: Store
	syncEngine?: SyncEngine | null
	children?: import('svelte').Snippet
}

const { store, syncEngine = null, children }: Props = $props()
</script>

<KoraStoreBridge {store} {syncEngine}>
	{#if children}
		{@render children()}
	{/if}
</KoraStoreBridge>

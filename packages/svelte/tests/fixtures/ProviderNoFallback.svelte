<script lang="ts">
import KoraProvider from '../../src/components/KoraProvider.svelte'
import type { KoraAppLike } from '../../src/types'

const { app }: { app: KoraAppLike } = $props()
</script>

<div data-testid="host"><KoraProvider {app} waitForStorage={true}><div>shell</div></KoraProvider></div>

<script lang="ts">
import type { Store } from '@korajs/store'
import SyncStatusProbe from './SyncStatusProbe.svelte'
import TestKoraProvider from './TestKoraProvider.svelte'

interface Props {
	store: Store
}

const { store }: Props = $props()
</script>

<TestKoraProvider {store}>
	<SyncStatusProbe />
</TestKoraProvider>

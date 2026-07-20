<script lang="ts">
import type { Store } from '@korajs/store'
import RichTextControls from './RichTextControls.svelte'
import TestKoraProvider from './TestKoraProvider.svelte'

interface Props {
	store: Store
}

const { store }: Props = $props()
</script>

<TestKoraProvider {store}>
	<RichTextControls />
</TestKoraProvider>

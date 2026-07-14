<script lang="ts">
import type { Store } from '@korajs/store'
import KoraRichText from '../../src/components/KoraRichText.svelte'
import TestKoraProvider from './TestKoraProvider.svelte'

interface Props {
	store: Store
}

const { store }: Props = $props()
</script>

<TestKoraProvider {store}>
	<KoraRichText collectionName="notes" recordId="rec-1" fieldName="body">
		{#snippet children(result)}
			<span data-testid="value">{result.ready ? result.text.toString() : 'loading'}</span>
		{/snippet}
	</KoraRichText>
</TestKoraProvider>

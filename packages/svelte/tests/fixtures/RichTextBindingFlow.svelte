<script lang="ts">
	import type { Store } from '@korajs/store'
	import RichTextBindingInner from './RichTextBindingInner.svelte'
	import TestKoraProvider from './TestKoraProvider.svelte'

	interface Props {
		store: Store
	}

	let { store }: Props = $props()
</script>

<TestKoraProvider {store}>
	<RichTextBindingInner />
</TestKoraProvider>

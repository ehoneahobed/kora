<script lang="ts">
	import type { Store } from '@korajs/store'
	import MutationApp from './MutationApp.svelte'
	import TestKoraProvider from './TestKoraProvider.svelte'

	interface Props {
		store: Store
	}

	let { store }: Props = $props()
</script>

<TestKoraProvider {store}>
	<MutationApp {store} />
</TestKoraProvider>

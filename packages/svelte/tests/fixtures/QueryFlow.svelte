<script lang="ts">
	import type { Store } from '@korajs/store'
	import QueryCount from './QueryCount.svelte'
	import TestKoraProvider from './TestKoraProvider.svelte'

	interface Props {
		store: Store
	}

	let { store }: Props = $props()
</script>

<TestKoraProvider {store}>
	<QueryCount query={store.collection('todos').where({})} />
</TestKoraProvider>

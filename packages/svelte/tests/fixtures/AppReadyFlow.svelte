<script lang="ts">
	import type { KoraAppLike } from '../../src/types'
	import type { Store } from '@korajs/store'
	import KoraProvider from '../../src/components/KoraProvider.svelte'
	import QueryCount from './QueryCount.svelte'

	interface Props {
		app: KoraAppLike
		store: Store
	}

	let { app, store }: Props = $props()
</script>

<KoraProvider {app}>
	<QueryCount query={store.collection('todos').where({})} />
</KoraProvider>

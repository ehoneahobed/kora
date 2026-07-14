<script lang="ts">
import type { Store } from '@korajs/store'
import KoraProvider from '../../src/components/KoraProvider.svelte'
import type { KoraAppLike } from '../../src/types'
import QueryCount from './QueryCount.svelte'

interface Props {
	app: KoraAppLike
	store: Store
}

const { app, store }: Props = $props()
</script>

<KoraProvider {app}>
	<QueryCount query={store.collection('todos').where({})} />
</KoraProvider>

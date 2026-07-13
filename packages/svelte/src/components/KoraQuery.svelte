<script lang="ts" module>
	import type { CollectionRecord, QueryBuilder } from '@korajs/store'
</script>

<script lang="ts" generics="T extends CollectionRecord = CollectionRecord">
	import { assertQueryReady } from '@korajs/store'
	import { getKoraContext } from '../context'

	interface Props {
		query: QueryBuilder<T>
		enabled?: boolean
		children?: import('svelte').Snippet<[readonly T[]]>
	}

	let { query, enabled = true, children }: Props = $props()

	getKoraContext()

	let data = $state<readonly T[]>([])

	$effect(() => {
		if (!enabled) {
			data = []
			return
		}

		const { queryStoreCache } = getKoraContext()
		assertQueryReady(query as QueryBuilder<unknown>)
		const queryStore = queryStoreCache.getOrCreate(query)
		const unsubscribe = queryStore.subscribe(() => {
			data = queryStore.getSnapshot()
		})
		data = queryStore.getSnapshot()

		return () => {
			unsubscribe()
			queryStoreCache.release(query as QueryBuilder<unknown>)
		}
	})
</script>

{#if children}
	{@render children(data)}
{/if}

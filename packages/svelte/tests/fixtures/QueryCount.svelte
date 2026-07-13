<script lang="ts">
	import type { Store } from '@korajs/store'
	import type { QueryBuilder } from '@korajs/store'
	import { createQueryStore } from '../../src/stores/query-store'

	interface Props {
		query: QueryBuilder
	}

	let { query }: Props = $props()
	const todos = createQueryStore(query)
</script>

<span data-testid="count">{$todos.length}</span>

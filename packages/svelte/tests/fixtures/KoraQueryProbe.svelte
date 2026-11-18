<script lang="ts">
import type { QueryBuilder } from '@korajs/store'
import KoraQuery from '../../src/components/KoraQuery.svelte'

interface Props {
	query: QueryBuilder
	onError?: (error: Error) => void
}

const { query, onError }: Props = $props()
</script>

<KoraQuery {query} {onError}>
	{#snippet children(rows, state)}
		<span data-testid="rows">{rows.map((row) => row.id).join(',')}</span>
		<span data-testid="error">{state?.error?.message ?? ''}</span>
	{/snippet}
</KoraQuery>

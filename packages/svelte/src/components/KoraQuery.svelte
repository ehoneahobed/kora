<script lang="ts" module>
import type { CollectionRecord, QueryBuilder } from '@korajs/store'
</script>

<script lang="ts" generics="T extends CollectionRecord = CollectionRecord">
	import { writable } from 'svelte/store'
	import { getKoraContext } from '../context'
	import { createQueryStateStore } from '../stores/query-store'
	import type { QueryState } from '../types'

	interface Props {
		query: QueryBuilder<T>
		enabled?: boolean
		/** A failed query; without it the failure is logged (it is also in the snippet's state). */
		onError?: (error: Error) => void
		/** The rows, and the full state: `{ data, error, ready, source, complete }`. */
		children?: import('svelte').Snippet<[readonly T[], QueryState<T>]>
	}

	let { query, enabled = true, onError, children }: Props = $props()

	getKoraContext()

	// The same machinery as createQueryStateStore: one ref-counted store per descriptor, so an
	// equal query keeps its store, and a new query shows the previous rows until it answers.
	// Filled by the effect below, which also follows every later query and `enabled`.
	const input = writable<QueryBuilder<T> | null>(null)
	const queryState = createQueryStateStore<T>(input, {
		onError: (failure) => {
			if (onError) onError(failure)
			else console.error('[Kora] KoraQuery failed:', failure)
		},
	})

	$effect(() => {
		input.set(enabled ? query : null)
	})
</script>

{#if children}
	{@render children($queryState.data, $queryState)}
{/if}

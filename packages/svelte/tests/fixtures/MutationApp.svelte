<script lang="ts">
import type { Store } from '@korajs/store'
import { createMutation } from '../../src/composables/use-mutation'
import { createQueryStore } from '../../src/stores/query-store'

interface Props {
	store: Store
}

const { store }: Props = $props()

const todos = createQueryStore(store.collection('todos').where({}))
const { mutate } = createMutation((title: string) => store.collection('todos').insert({ title }))
</script>

<div>
	<span data-testid="count">{$todos.length}</span>
	<button type="button" data-testid="add" onclick={() => mutate('New todo')}>Add</button>
</div>

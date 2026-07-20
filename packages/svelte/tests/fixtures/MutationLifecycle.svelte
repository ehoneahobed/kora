<script lang="ts">
import { createMutation } from '../../src/composables/use-mutation'
import type { UseMutationResult } from '../../src/types'

interface Props {
	mutationFn: (...args: unknown[]) => Promise<unknown>
	onready: (mutation: UseMutationResult<unknown, unknown[]>) => void
}

const { mutationFn, onready }: Props = $props()

const mutation = createMutation(mutationFn)
onready(mutation)

let loading = $state(false)
let error = $state<string>('null')

$effect(() =>
	mutation.subscribeLoading((value) => {
		loading = value
	}),
)
$effect(() =>
	mutation.subscribeError((value) => {
		error = value ? value.message : 'null'
	}),
)
</script>

<span data-testid="loading">{loading}</span>
<span data-testid="error">{error}</span>
<button type="button" data-testid="mutate" onclick={() => mutation.mutate('arg1')}>mutate</button>

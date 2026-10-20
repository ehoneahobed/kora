<script lang="ts">
import type { KoraEventEmitter } from '@korajs/core'
import { QueryStoreCache } from '@korajs/store'
import type { Store } from '@korajs/store'
import { setKoraContext } from '../../src/context'
import { createMutation } from '../../src/composables/use-mutation'
import type { MutationRejection, UseMutationResult } from '../../src/types'

interface Props {
	events: KoraEventEmitter
	mutationFn: (id: string) => Promise<unknown>
	onRejected: (rejection: MutationRejection<[string]>) => void
	onready: (mutation: UseMutationResult<unknown, [string]>) => void
}

const { events, mutationFn, onRejected, onready }: Props = $props()

setKoraContext({
	store: {} as Store,
	syncEngine: null,
	app: null,
	events,
	subscribeSyncStatus: null,
	queryStoreCache: new QueryStoreCache(),
})

const mutation = createMutation(mutationFn, { onRejected })
onready(mutation)

let rejected = $state('none')
$effect(() =>
	mutation.subscribeRejected((value) => {
		rejected = value ? `${value.code}:${value.args[0]}` : 'none'
	}),
)
</script>

<span data-testid="rejected">{rejected}</span>

<script lang="ts">
import { isPendingStore } from '@korajs/core/bindings'
import { asRichTextSyncEngine, createRichTextController } from '@korajs/store'
import type { CollectionAccessor } from '@korajs/store'
import type { AwarenessUser } from '@korajs/sync'
import { getKoraContext } from '../context'
import type { UseRichTextResult } from '../types'

interface Props {
	collectionName: string
	recordId: string
	fieldName: string
	user?: AwarenessUser
	useDocChannel?: boolean
	children?: import('svelte').Snippet<[UseRichTextResult]>
}

const { collectionName, recordId, fieldName, user, useDocChannel, children }: Props = $props()

const context = getKoraContext()
let result = $state<UseRichTextResult | null>(null)
// Flips when the provider's store opens (it renders before): the effect below re-runs on it.
let opened = $state(!isPendingStore(context.store))
if (!opened) {
	context.app?.ready.then(
		() => {
			opened = true
		},
		() => {},
	)
}

/** While the store opens, `findById` waits for `app.ready` (the early accessor refuses). */
function accessor(store: typeof context.store): CollectionAccessor {
	const early = store.collection(collectionName)
	if (!isPendingStore(store) || !context.app) return early
	const app = context.app
	return {
		...early,
		async findById(id: string) {
			await app.ready
			return app.getStore().collection(collectionName).findById(id)
		},
	}
}

$effect(() => {
	void opened
	const { store, syncEngine } = context
	const controller = createRichTextController({
		collection: accessor(store),
		collectionName,
		recordId,
		fieldName,
		store,
		syncEngine: asRichTextSyncEngine(syncEngine),
		useDocChannel,
		user,
	})

	const sync = (): void => {
		const snapshot = controller.getSnapshot()
		result = {
			doc: controller.doc,
			text: controller.text,
			undo: () => controller.undo(),
			redo: () => controller.redo(),
			ready: snapshot.ready,
			error: snapshot.error,
			canUndo: snapshot.canUndo,
			canRedo: snapshot.canRedo,
			cursors: [...snapshot.cursors],
			setCursor: (anchor, head) => controller.setCursor(anchor, head),
			clearCursor: () => controller.clearCursor(),
		}
	}

	sync()
	const unsubscribe = controller.subscribe(sync)

	return () => {
		unsubscribe()
		controller.destroy()
		result = null
	}
})
</script>

{#if result && children}
	{@render children(result)}
{/if}

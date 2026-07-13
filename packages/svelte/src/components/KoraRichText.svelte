<script lang="ts">
	import { asRichTextSyncEngine, createRichTextController } from '@korajs/store'
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

	let { collectionName, recordId, fieldName, user, useDocChannel, children }: Props = $props()

	const { store, syncEngine } = getKoraContext()
	let result = $state<UseRichTextResult | null>(null)

	$effect(() => {
		const controller = createRichTextController({
			collection: store.collection(collectionName),
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

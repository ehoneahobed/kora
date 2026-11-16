import { isPendingStore } from '@korajs/core/bindings'
import { asRichTextSyncEngine, createRichTextController } from '@korajs/store'
import type { CollectionAccessor } from '@korajs/store'
import type { AwarenessUser } from '@korajs/sync'
import { onDestroy } from 'svelte'
import { type Readable, get, readable } from 'svelte/store'
import { getKoraContext } from '../context'
import type { UseRichTextResult } from '../types'

export interface UseRichTextOptions {
	user?: AwarenessUser
	useDocChannel?: boolean
}

/**
 * Binds a richtext field to a shared Yjs document for editor integration.
 *
 * Must be called during component initialization. For reactive target changes,
 * use {@link KoraRichText} instead.
 */
export function createRichTextBinding(
	collectionName: string,
	recordId: string,
	fieldName: string,
	options?: UseRichTextOptions,
): UseRichTextResult & { subscribe: Readable<UseRichTextResult>['subscribe'] } {
	const { app, store, syncEngine } = getKoraContext()

	const controller = createRichTextController({
		collection:
			isPendingStore(store) && app
				? collectionWhenReady(app, store.collection(collectionName), collectionName)
				: store.collection(collectionName),
		collectionName,
		recordId,
		fieldName,
		store,
		syncEngine: asRichTextSyncEngine(syncEngine),
		useDocChannel: options?.useDocChannel,
		user: options?.user,
	})

	onDestroy(() => {
		controller.destroy()
	})

	const resultStore = readable<UseRichTextResult>(buildResult(controller), (set) => {
		const sync = (): void => {
			set(buildResult(controller))
		}
		sync()
		return controller.subscribe(sync)
	})

	return {
		get doc() {
			return controller.doc
		},
		get text() {
			return controller.text
		},
		undo: () => controller.undo(),
		redo: () => controller.redo(),
		get ready() {
			return get(resultStore).ready
		},
		get error() {
			return get(resultStore).error
		},
		get canUndo() {
			return get(resultStore).canUndo
		},
		get canRedo() {
			return get(resultStore).canRedo
		},
		get cursors() {
			return get(resultStore).cursors
		},
		setCursor: (anchor: number, head: number) => controller.setCursor(anchor, head),
		clearCursor: () => controller.clearCursor(),
		get hasUnsavedChanges() {
			return get(resultStore).hasUnsavedChanges
		},
		retrySave: () => controller.retrySave(),
		getUnsavedState: () => controller.getUnsavedState(),
		subscribe: resultStore.subscribe,
	}
}

/** @alias createRichTextBinding */
export const useRichText = createRichTextBinding

function buildResult(controller: ReturnType<typeof createRichTextController>): UseRichTextResult {
	const snapshot = controller.getSnapshot()
	return {
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
		hasUnsavedChanges: snapshot.hasUnsavedChanges,
		retrySave: () => controller.retrySave(),
		getUnsavedState: () => controller.getUnsavedState(),
	}
}

/**
 * The accessor to give the controller while the store is still opening (the provider renders
 * before it): the early accessor refuses `findById`, so this one waits for `app.ready` and
 * reads the open store, as `KoraRichText` and the React and Vue bindings do.
 */
function collectionWhenReady(
	app: { ready: Promise<void>; getStore(): { collection(name: string): CollectionAccessor } },
	early: CollectionAccessor,
	name: string,
): CollectionAccessor {
	return {
		...early,
		async findById(id: string) {
			await app.ready
			return app.getStore().collection(name).findById(id)
		},
	}
}

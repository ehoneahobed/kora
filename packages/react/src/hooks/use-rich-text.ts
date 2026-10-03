import { asRichTextSyncEngine, createRichTextController } from '@korajs/store'
import type { RichTextControllerSnapshot } from '@korajs/store'
import type { AwarenessUser } from '@korajs/sync'
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useKoraContext } from '../context/kora-context'
import type { UseRichTextResult } from '../types'
import { useController } from './use-controller'

export interface UseRichTextOptions {
	user?: AwarenessUser
	useDocChannel?: boolean
}

/**
 * Binds a richtext field to a shared Yjs document for editor integration.
 */
export function useRichText(
	collectionName: string,
	recordId: string,
	fieldName: string,
	options?: UseRichTextOptions,
): UseRichTextResult {
	const { store, syncEngine } = useKoraContext()
	const collection = useMemo(() => store.collection(collectionName), [store, collectionName])

	const controller = useController(
		() =>
			createRichTextController({
				collection,
				collectionName,
				recordId,
				fieldName,
				store,
				syncEngine: asRichTextSyncEngine(syncEngine),
				useDocChannel: options?.useDocChannel,
				user: options?.user,
			}),
		(instance) => instance.destroy(),
		[collection, collectionName, fieldName, options?.useDocChannel, recordId, store, syncEngine],
	)
	const getController = controller.get

	// biome-ignore lint/correctness/useExhaustiveDependencies: a replaced controller (version) needs the user again
	useEffect(() => {
		getController().setUser(options?.user)
	}, [getController, options?.user, controller.version])

	// biome-ignore lint/correctness/useExhaustiveDependencies: version re-keys subscribe when the controller is replaced
	const subscribe = useCallback(
		(onStoreChange: () => void) => getController().subscribe(onStoreChange),
		[getController, controller.version],
	)
	const getSnapshot = useCallback(() => getController().getSnapshot(), [getController])
	const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

	const undo = useCallback(() => {
		getController().undo()
	}, [getController])
	const redo = useCallback(() => {
		getController().redo()
	}, [getController])
	const setCursor = useCallback(
		(anchor: number, head: number) => getController().setCursor(anchor, head),
		[getController],
	)
	const clearCursor = useCallback(() => getController().clearCursor(), [getController])

	const live = getController()
	// The result keeps its identity until the snapshot or the controller changes (DX-5).
	// biome-ignore lint/correctness/useExhaustiveDependencies: version marks a replaced controller
	return useMemo(
		() => buildResult(live, snapshot, undo, redo, setCursor, clearCursor),
		[live, snapshot, undo, redo, setCursor, clearCursor, controller.version],
	)
}

function buildResult(
	controller: ReturnType<typeof createRichTextController>,
	snapshot: RichTextControllerSnapshot,
	undo: () => void,
	redo: () => void,
	setCursor: (anchor: number, head: number) => void,
	clearCursor: () => void,
): UseRichTextResult {
	return {
		doc: controller.doc,
		text: controller.text,
		undo,
		redo,
		canUndo: snapshot.canUndo,
		canRedo: snapshot.canRedo,
		ready: snapshot.ready,
		error: snapshot.error,
		cursors: [...snapshot.cursors],
		setCursor,
		clearCursor,
	}
}

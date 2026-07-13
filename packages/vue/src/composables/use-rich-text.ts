import { asRichTextSyncEngine, createRichTextController } from '@korajs/store'
import type { AwarenessUser } from '@korajs/sync'
import { reactive, shallowRef, watch } from 'vue'
import { useKoraContext } from '../context'
import type { UseRichTextResult } from '../types'

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
	const controllerRef = shallowRef<ReturnType<typeof createRichTextController> | null>(null)

	const state = reactive({
		ready: false,
		error: null as Error | null,
		canUndo: false,
		canRedo: false,
		cursors: [] as UseRichTextResult['cursors'],
	})

	watch(
		() => [collectionName, recordId, fieldName, options?.useDocChannel] as const,
		([name, id, field, useDocChannel], _previous, onCleanup) => {
			controllerRef.value?.destroy()

			const controller = createRichTextController({
				collection: store.collection(name),
				collectionName: name,
				recordId: id,
				fieldName: field,
				store,
				syncEngine: asRichTextSyncEngine(syncEngine),
				useDocChannel,
				user: options?.user,
			})

			const syncState = (): void => {
				const snapshot = controller.getSnapshot()
				state.ready = snapshot.ready
				state.error = snapshot.error
				state.canUndo = snapshot.canUndo
				state.canRedo = snapshot.canRedo
				state.cursors = [...snapshot.cursors]
			}

			syncState()
			const unsubscribe = controller.subscribe(syncState)
			controllerRef.value = controller

			onCleanup(() => {
				unsubscribe()
				controller.destroy()
				if (controllerRef.value === controller) {
					controllerRef.value = null
				}
			})
		},
		{ immediate: true },
	)

	watch(
		() => options?.user,
		(user) => {
			controllerRef.value?.setUser(user)
		},
	)

	const controller = (): NonNullable<typeof controllerRef.value> => {
		if (!controllerRef.value) {
			throw new Error('useRichText controller is not initialized')
		}
		return controllerRef.value
	}

	return {
		get doc() {
			return controller().doc
		},
		get text() {
			return controller().text
		},
		undo: () => controller().undo(),
		redo: () => controller().redo(),
		get ready() {
			return state.ready
		},
		get error() {
			return state.error
		},
		get canUndo() {
			return state.canUndo
		},
		get canRedo() {
			return state.canRedo
		},
		get cursors() {
			return state.cursors
		},
		setCursor: (anchor: number, head: number) => controller().setCursor(anchor, head),
		clearCursor: () => controller().clearCursor(),
	}
}

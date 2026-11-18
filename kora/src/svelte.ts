/**
 * Svelte bindings, re-exported from `@korajs/svelte` for `import { ... } from 'korajs/svelte'`.
 * Every export is listed (no `export *`): meta-exports.test.ts fails when `@korajs/svelte` gains
 * a value or type that is missing here.
 */
export type {
	FormDraftStore,
	KoraAppHandle,
	KoraAppLike,
	KoraContextValue,
	MutationRejection,
	OfflineKeepStore,
	OfflineReason,
	OfflineStatus,
	QueryInput,
	QueryState,
	SvelteFormDraftOptions,
	UseMutationOptions,
	UseMutationResult,
	UseQueryOptions,
	UseRichTextOptions,
	UseRichTextResult,
} from '@korajs/svelte'

export {
	applyPresence,
	createCollaboratorsStore,
	createMutation,
	createOfflineKeepStore,
	createOfflineReadyStore,
	createQueryStateStore,
	createQueryStore,
	createRichTextBinding,
	createSyncStatusStore,
	getApp,
	getCollection,
	getKoraApp,
	getKoraContext,
	initKoraProvider,
	setKoraAppContext,
	setKoraContext,
	useApp,
	useCollaborators,
	useCollection,
	useFormDraft,
	useMutation,
	useOfflineKeep,
	useOfflineReady,
	usePresence,
	useQuery,
	useQueryState,
	useRichText,
	useSyncStatus,
} from '@korajs/svelte'

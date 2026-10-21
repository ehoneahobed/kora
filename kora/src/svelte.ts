/**
 * Svelte bindings — re-exported from `@korajs/svelte` for `import { ... } from 'korajs/svelte'`.
 */
export type {
	KoraAppHandle,
	KoraAppLike,
	KoraContextValue,
	MutationRejection,
	UseMutationOptions,
	UseMutationResult,
	UseQueryOptions,
	UseRichTextResult,
	QueryInput,
	QueryState,
} from '@korajs/svelte'

export type { UseRichTextOptions } from '@korajs/svelte'

export {
	createMutation,
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
	useCollection,
	useMutation,
	useQuery,
	useQueryState,
	useRichText,
	useSyncStatus,
	useFormDraft,
	applyPresence,
	usePresence,
	createCollaboratorsStore,
	useCollaborators,
} from '@korajs/svelte'

export type { FormDraftStore, SvelteFormDraftOptions } from '@korajs/svelte'

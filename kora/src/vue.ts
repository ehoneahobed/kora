/**
 * Vue 3 bindings — re-exported from `@korajs/vue` for `import { ... } from 'korajs/vue'`.
 */
export type {
	KoraAppHandle,
	KoraAppLike,
	KoraContextValue,
	KoraProviderProps,
	MutationRejection,
	UseMutationOptions,
	UseMutationResult,
	UseQueryOptions,
	UseQueryStateResult,
	UseRichTextResult,
	QueryInput,
} from '@korajs/vue'

export type { UseRichTextOptions } from '@korajs/vue'

export {
	KoraProvider,
	installKora,
	koraAppInjectionKey,
	koraContextKey,
	useApp,
	useCollection,
	useKoraApp,
	useKoraContext,
	useMutation,
	useQuery,
	useQueryState,
	useRichText,
	useSyncStatus,
	useFormDraft,
	usePresence,
	useCollaborators,
} from '@korajs/vue'

export type { UseFormDraftResult } from '@korajs/vue'

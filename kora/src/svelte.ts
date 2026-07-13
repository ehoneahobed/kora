/**
 * Svelte bindings — re-exported from `@korajs/svelte` for `import { ... } from 'korajs/svelte'`.
 */
export type {
	KoraAppHandle,
	KoraAppLike,
	KoraContextValue,
	UseMutationOptions,
	UseMutationResult,
	UseQueryOptions,
	UseRichTextResult,
} from '@korajs/svelte'

export type { UseRichTextOptions } from '@korajs/svelte'

export {
	createMutation,
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
	useRichText,
	useSyncStatus,
	applyPresence,
	usePresence,
	createCollaboratorsStore,
	useCollaborators,
} from '@korajs/svelte'

// @korajs/react — public API
// Every export here is a public API commitment. Be explicit.

// === Types ===
export type {
	KoraAppLike,
	KoraContextValue,
	KoraProviderProps,
	UseQueryOptions,
	UseQueryStateResult,
	MutationRejection,
	UseMutationOptions,
	UseMutationResult,
	UseRichTextResult,
} from './types'

// === Context ===
export { KoraProvider } from './context/kora-context'
export {
	AuthBoundKoraProvider,
	classifyKoraInitializationError,
} from './context/auth-bound-kora-provider'
export type {
	AuthBoundKoraErrorContext,
	AuthBoundKoraInitializationError,
	AuthBoundKoraProviderProps,
	AuthBoundKoraSession,
} from './context/auth-bound-kora-provider'

// === Hooks ===
export { useApp } from './hooks/use-app'
export { useQuery, useQueryState } from './hooks/use-query'
export { createKoraHooks } from './hooks/create-kora-hooks'
export type {
	AccessorRecord,
	AppCollectionName,
	AppCollections,
	AppRecord,
	KoraHooks,
} from './hooks/create-kora-hooks'
export { useMutation } from './hooks/use-mutation'
export { useOfflineReady } from './hooks/use-offline-ready'
export { useSyncStatus } from './hooks/use-sync-status'
export { useFormDraft } from './hooks/use-form-draft'
export type { UseFormDraftResult } from './hooks/use-form-draft'
export { useCollection } from './hooks/use-collection'
export { useRichText } from './hooks/use-rich-text'
export type { UseRichTextOptions } from './hooks/use-rich-text'
export { usePresence } from './hooks/use-presence'
export { useCollaborators } from './hooks/use-collaborators'

export type { OfflineReason, OfflineStatus } from '@korajs/core/bindings'

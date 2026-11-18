---
'korajs': patch
---

`korajs/react` now re-exports everything `@korajs/react` exports. `useSyncSummary`, `AuthBoundKoraProvider` and `classifyKoraInitializationError`, with the `AuthBoundKoraProviderProps`, `OfflineReason` and `OfflineStatus` types, were documented but could only be imported from `@korajs/react`. `korajs/vue` and `korajs/svelte` re-export their whole packages in the same way, so the subpaths can't drift from their packages again.

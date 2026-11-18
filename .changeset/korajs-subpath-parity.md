---
'korajs': patch
---

`korajs/react` now re-exports everything `@korajs/react` exports. `useSyncSummary`, `AuthBoundKoraProvider` and `classifyKoraInitializationError`, with the `AuthBoundKoraProviderProps`, `OfflineReason` and `OfflineStatus` types, were documented but could only be imported from `@korajs/react`. `korajs/vue` and `korajs/svelte` now list every value and type of their packages too. Each subpath names its exports explicitly, and a test fails when a binding package gains a value or type that its `korajs/*` subpath doesn't re-export.

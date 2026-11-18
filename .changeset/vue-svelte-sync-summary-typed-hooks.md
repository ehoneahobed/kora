---
'@korajs/vue': minor
'@korajs/svelte': minor
'@korajs/sync': patch
'korajs': patch
---

Vue and Svelte get the two React APIs they were missing:

- **`useSyncSummary()`.** The sync status summarized for an indicator (`tone`, `title`, `detail`). In Vue it's a computed ref. In Svelte it's a readable store, as `createSyncSummaryStore()` or `useSyncSummary()`.
- **`createKoraHooks<typeof app>()`.** Typed collection names, accessors and rows from your app's schema.

`summarizeSyncStatus` is now also exported from `@korajs/sync/lite`, so an indicator can render at first paint. `korajs/vue` and `korajs/svelte` re-export the new APIs.

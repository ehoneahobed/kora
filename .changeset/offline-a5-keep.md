---
"@korajs/core": minor
"@korajs/store": minor
"@korajs/sync": minor
"@korajs/react": minor
"@korajs/vue": minor
"@korajs/svelte": minor
"korajs": minor
---

`app.offline.keep(query, { files })` keeps data on the device on purpose: it returns a handle (`status`, `subscribe`, `whenComplete`) and `app.offline.release`, `hold` (reference counted, for components) and `list` complete the API. Pins are stored in the device database, widen the sync query views so `data.state` is judged over them, are limited to 64 (`OFFLINE_PIN_LIMIT`) and refuse `limit`, `offset` and `include`. Holds of a closed or killed tab are pruned by the other tabs. With `files: true` one elected tab fetches the referenced blobs in the background, verified by SHA-256, and reports `quota`, `unavailable`, `integrity` or `error` failures; persistent storage is requested in the background. `useOfflineKeep` is available in `@korajs/react`, `@korajs/vue` and `@korajs/svelte` (and `korajs/*`). Blob stores gain a `durable` flag.

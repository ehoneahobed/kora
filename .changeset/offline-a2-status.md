---
"@korajs/core": minor
"@korajs/store": minor
"@korajs/sync": minor
"korajs": minor
"@korajs/react": minor
"@korajs/vue": minor
"@korajs/svelte": minor
---

`app.offline.status()` and `app.offline.subscribe()` report whether a reload with no network would open the app with its data, and `useOfflineReady()` (React, Vue, Svelte `createOfflineReadyStore`) renders it. `data.state` is `complete` only on a durable completion mark, written in the same transaction as the delivery watermark of a fully applied final batch, cleared before a batch that narrows the view or removes records and by every watermark reset, and held back by a delivery-unit key while a unit that spans several transactions is open: a delivery that crashed or stalled mid-way is never `complete` after a reload. On the IndexedDB fallback a mark counts once a persisted snapshot holds it. Readiness changes reach other tabs through the new `kora-offline-meta-changed` bus message. The shell, files and sign-in components report `none`, zeros and `unknown` until their steps land, so no app reads `ready` yet. `offline` joins the reserved app property names.

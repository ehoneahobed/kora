---
"@korajs/vue": patch
"@korajs/svelte": patch
---

`useQueryState` (Vue) and `createQueryStateStore` (Svelte) now return `source` (`'server'`, `'local'` or `'pending'`) and `complete`, as the React hook does: an app can say "showing what is on this device so far" while a first visit is still replicating, with the same flags in every binding.

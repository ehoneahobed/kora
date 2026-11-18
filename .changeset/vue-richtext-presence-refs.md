---
'@korajs/vue': patch
---

`useRichText` and `usePresence` now accept refs and getters, like `useQuery` already does. When a record id changes, for example in an editor reused across routes, `useRichText` moves to the new record; it used to keep editing the first one. A user ref or getter passed to `usePresence` now updates what collaborators see, and `null` clears it. Before, only a `reactive()` object was followed.

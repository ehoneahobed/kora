---
'@korajs/test': patch
'@korajs/vue': patch
'@korajs/svelte': patch
---

`@korajs/test` now ships a README. `docs/api/errors.md` lists every error code in the source; a repository test keeps it that way, and checks that every published package has a README. The Vue and Svelte README setup snippets now match the sync templates: `lazyAuthSync`, a `connect()` that isn't awaited, and the sign-in UI mounted after the first paint.

---
'@korajs/svelte': patch
---

A `createRichTextBinding`/`useRichText` binding created before the store opens now gets the sync engine once `app.ready` resolves, so collaborators' cursors and the live document channel work. Before the store opens is the default when the provider renders early. The binding used to read the engine once, while it was still null, so collaborators never appeared.

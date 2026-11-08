---
'@korajs/core': patch
'@korajs/spaces': patch
'korajs': patch
---

`useMembers`, `useInvitations` and `useMyRole` no longer throw "Store not initialized" when they render before the store opens. With first-visit read-through the tree renders before `app.ready`, and these hooks called `app.getStore()` while rendering, which broke the page (an error boundary) on a hard load of a collaborators panel. They now use the app's pre-ready collection accessors and the schema, which the app now exposes as `app.schema`. `schema` joins the reserved app properties, so a collection named `schema` is reached through `app.collections.schema`.

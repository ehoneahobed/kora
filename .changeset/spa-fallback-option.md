---
'@korajs/server': patch
---

New `spaFallback` option on `createProductionServer` (F7): `'extensionless'` answers every
missing path without a file extension (outside `/assets/`) with the app shell, so a service
worker can warm app routes with a plain `fetch(url)`. The default, `'navigation'`, keeps the
shell for browser navigations only, and the guide shows the `Accept: text/html` header that
makes a service-worker fetch count as one.

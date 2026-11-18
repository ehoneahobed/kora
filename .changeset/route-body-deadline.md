---
'@korajs/server': patch
---

Custom route bodies (`httpRoutes`: auth, webhooks, app APIs) now have a deadline and an in-flight cap, as the read endpoint already did.

- **Deadline:** a body must arrive within 2 s plus 1 s per KiB, at most 30 s. A slower body gets `408` and the connection is closed. Before, a client that sent headers and stalled could hold a connection until Node's 300 s request timeout.
- **Cap:** at most `maxConcurrentRequestBodies` bodies (128 by default) are read at once. Past it, a request with a body gets `503` with `Retry-After`.

---
'@korajs/sync': patch
---

The client keeps the query views in its handshake under the cap even when more than 500 collections each have one view. Collapsing a single-view collection to the whole collection used to save nothing, so the server could still refuse the handshake. Collections over the cap are now left unrestricted, which syncs them whole.

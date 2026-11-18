---
'@korajs/server': patch
---

Live rich-text updates (`yjs-doc-update`) are now bounded for each sync session. Each one costs a store read and goes out to every peer in scope, so a flooding writer could push peers past their send buffer and get them disconnected. Two new limits apply. `maxYjsUpdatesPerMinute` (default 1200) caps how many a session sends; past it, updates are dropped with the retriable `YJS_UPDATE_THROTTLED`. `maxYjsUpdateBytes` (default 1 MiB) caps the size; anything larger is refused with `YJS_UPDATE_TOO_LARGE`. The session stays open, and nothing durable is lost, because rich text also syncs as operations.

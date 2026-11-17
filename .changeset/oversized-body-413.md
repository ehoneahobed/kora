---
'@korajs/server': patch
---

A client uploading an oversized body to a custom HTTP route (or the backup import) now receives the `413` instead of a reset connection. The server used to close the socket right after replying while the upload was still arriving. It now discards the rest of the body (never buffered) for at most 5 s or 64 MiB, then closes.

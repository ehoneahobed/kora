---
"@korajs/store": minor
"korajs": minor
---

Persist blobs in the browser and expose a first-class `app.blobs` API, closing the gap between "blobs sync" and "blobs sync with zero developer effort".

- `@korajs/store` adds `OpfsBlobStore`, a durable content-addressed blob store backed by the browser Origin Private File System (the same storage the SQLite adapter uses). Blobs survive reloads, are sharded by hash prefix, deduplicated, and integrity-verified on read; writes commit atomically so a torn write is never trusted. Its logic runs against a small `OpfsBlobDirectory` port, so it is fully unit-tested without a browser, and `createOpfsBlobStore()` gives the real navigator.storage-backed instance (best-effort requesting persistent storage to resist eviction).
- `korajs` now holds a blob store on every app and exposes `app.blobs`: `put` (store bytes, returning the `BlobRef` to attach to a record plus the manifest a peer needs to pull), `get` / `has` / `delete` for local bytes, and `pull(manifest)` to fetch a blob's bytes from peers over the live sync connection, fetching only missing chunks and verifying integrity. The backend is chosen by environment — OPFS in the browser, in-memory elsewhere — and is overridable via `blob.store` in `createApp` config. When sync is enabled, the app automatically serves the chunks it holds, so a blob authored on one device is pullable on another with no wiring.

The default is durable and offline-first: local blob reads and writes work with no connection, and a browser that advertises OPFS but fails to open it degrades to in-memory with a warning rather than failing startup.

Known boundary: `pull` takes a manifest today. Pulling from a bare `BlobRef` alone (resolving its manifest by hash) is a deliberate next step, since it requires a manifest-distribution decision (embed in the ref, a manifest object addressed by its own hash, or carry it in the operation log).

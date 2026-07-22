---
"@korajs/store": minor
---

Add a persistent filesystem-backed blob store (`@korajs/store/blob-fs`).

`FilesystemBlobStore` implements the `ContentAddressedBlobStore` contract on disk, so blobs survive process restarts instead of living only in memory. It is a node-only subpath export (like the better-sqlite3 adapter) so `node:fs` never enters a browser bundle.

- Blobs are stored at `<dir>/<hash[0:2]>/<hash>`, sharded by hash prefix so a single directory never holds millions of entries.
- Writes are atomic (temp file then rename), so a crash mid-write can never leave a partial blob under a hash that readers would then trust.
- Same content-addressed guarantees as `MemoryBlobStore`: `put` deduplicates identical content, and `get` verifies the on-disk bytes hash to the requested key (throwing `BlobIntegrityError` on corruption). It drops into the blob transfer path (chunk staging, blob destination) unchanged.

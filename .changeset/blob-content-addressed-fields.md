---
"@korajs/core": minor
"@korajs/store": minor
"@korajs/merge": minor
---

Add a `blob` field type backed by a content-addressed store (data model + store core).

Files no longer belong in the operation log. A `blob` field carries a small content-addressed reference, and the bytes live in a deduplicated, integrity-checked store keyed by their hash.

- `t.blob()` fields hold a `BlobRef` (`{ hash, size, mimeType?, filename? }`), a hex SHA-256 content address plus metadata. Values persist as JSON (`TEXT`) and converge by last-write-wins on the reference (the bytes are immutable and deduplicated by hash, so the reference is the only thing that can change).
- `@korajs/core` exposes `hashBlob`, `createBlobRef`, and `isBlobRef` (reusing the same SHA-256 content addressing as operation ids).
- `@korajs/store` adds a `ContentAddressedBlobStore` interface and a `MemoryBlobStore` backend: `put` deduplicates identical content (stored once, same hash), and `get` verifies the stored bytes hash to the requested key, throwing `BlobIntegrityError` on corruption rather than returning bad data.

Proven with unit tests (content addressing, dedup, integrity, buffer-isolation) and validated end-to-end through the real store + sync path (a blob reference round-trips through insert and converges under concurrent replacement). The out-of-band, resumable, chunked byte-transfer channel and persistent backends (OPFS, filesystem/S3) build on top of this reference model.

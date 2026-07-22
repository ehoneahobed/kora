---
"@korajs/store": minor
---

Add out-of-band, resumable, chunked blob transfer (the byte-transfer half of the `blob` field).

Blob bytes move on a dedicated content-addressed channel, not in the operation log, so large files sync without bloating or re-sending the log.

- `chunkBlob(bytes, chunkSize?)` splits a blob into content-addressed chunks and produces a `BlobManifest` (blob hash, size, ordered chunk hashes, metadata). Identical chunks collapse to one stored entry while the ordered hash list still reproduces the exact bytes.
- `reassembleBlob(manifest, chunkStore)` rebuilds the blob with integrity checks at both levels: each chunk is verified on read, and the reassembled whole is verified against the manifest's blob hash.
- `receiveBlob(manifest, provider, { chunkStore, blobStore })` performs a resumable transfer: chunks already staged (from a prior interrupted transfer) are skipped, each fetched chunk is verified to hash to its expected value before staging, and the completed blob is written to the destination store. The transfer is idempotent, deduplicates repeated chunks, and rejects tampered or missing chunks (`BlobIntegrityError`).
- `prepareBlobForSend(bytes, chunkStore, options?)` stages a blob's chunks and returns a manifest plus a `ChunkProvider` that serves them.

The protocol is transport-agnostic (proven with an in-memory provider and property-style resumability/idempotency tests). Wiring it onto the live sync connection, plus persistent chunk/blob backends (OPFS, filesystem/S3), is the remaining integration step.

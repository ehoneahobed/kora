---
"@korajs/store": minor
---

Add a transport-agnostic request/response protocol for pulling blob chunks over any message channel. This is the wire piece that lets a device fetch a blob's content out of band from a peer that holds it (the sync WebSocket in production, an in-memory pair in tests), rather than inlining bytes into the operation stream.

- `createRemoteChunkProvider(port)` returns a `ChunkProvider` that requests chunks by hash over a `ChunkMessagePort`, correlates each answer to its request by `requestId`, and times a stalled request out (default 30s) so a dropped response cannot hang a transfer. Because transfers are resumable, a timed-out request is simply retried on the next pull.
- `serveBlobChunks(port, blobStore)` answers incoming chunk requests from a content-addressed store. A chunk the store does not hold (or whose stored bytes fail their integrity check on read) is reported as unavailable rather than crashing the connection, so a corrupt server-side chunk surfaces to the receiver as a missing chunk instead of a silent bad transfer.
- `createChunkPortPair()` provides a connected in-memory duplex pair of ports with asynchronous (next-microtask) delivery, modeling a real transport for tests.

Composes with the existing `receiveBlob`/`prepareBlobForSend` resumable transfer: skip-already-staged chunks are never requested, and only missing chunks cross the port.

---
'@korajs/server': patch
---

A sync session's queue of received messages is now bounded. Messages are handled one at a time, so a peer could send a handshake to a server whose sign-in is slow, then flood frames of up to 32 MiB each, and the server parsed and held every one. Until a handshake is accepted, only 16 messages may wait. After that, the limits are `maxQueuedMessages` (default 10000) and `maxQueuedBytes` (default 64 MiB). Past either limit, the session is closed with the retriable `INBOUND_QUEUE_FULL` error. The WebSocket transport reports each frame's size to the session.

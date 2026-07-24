---
"@korajs/server": patch
---

Make server-to-client relay reliable, closing a lost-operation bug under a lossy
transport.

Real-time relay was fire-and-forget: if the transport dropped a relayed operation
batch, the client never received it. Because a later operation from the same node
still advanced the client's version vector past the missing one, delta sync on the
next handshake would never re-send it, so the operation was lost and that client
diverged permanently (a violation of the "no operation is ever lost" guarantee).

The server now tracks each relay batch until the client acknowledges it (clients
already ack every applied batch by messageId) and retransmits anything still unacked
on a periodic tick. Redelivering an already-applied operation is harmless because
clients dedup by content-addressed id. The pending set is bounded per session and
cleared on close.

Note: this closes the common case where the connection stays up while individual
messages drop. A drop immediately followed by a reconnect (before retransmit) is not
yet covered — that requires delivery tracking durable across reconnects, tracked
separately.

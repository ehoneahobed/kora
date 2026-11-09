---
'@korajs/server': patch
---

The delivery stream now pauses once 2 MiB (`deliveryMaxUnackedBytes`) is sent but not acknowledged, so a client that freezes costs one bounded retransmission instead of repeating its whole backlog. Each retransmission is logged as `session.delivery_rewind`.

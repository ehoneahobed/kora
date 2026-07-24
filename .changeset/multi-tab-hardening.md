---
"@korajs/store": minor
---

Harden multi-tab SQLite WASM storage coordination.

- Add leader liveness and a readiness handshake to the leader/follower fallback:
  the leader relay answers `ping` with `pong`, followers expose `waitForLeader()`
  so a follower opened during a leader's startup race retries the handshake instead
  of firing into the void, and a stalled follower RPC now fails fast with
  `NoLeaderError` when the leader is confirmed absent instead of waiting out the
  full timeout.
- Add automatic failover: a follower queues a blocking lock request and, when the
  previous leader releases the storage lock (its tab closed or crashed), is promoted
  to leader and rebuilds its own worker (safe under the OPFS single-writer rule
  because the lock is only granted once the old leader is gone).

---
"@korajs/sync": patch
"@korajs/store": patch
"korajs": patch
---

A stopped or disconnected sync engine no longer keeps its diagnostics interval running (it emitted `sync:diagnostics` every 5 s forever after the first connection). A Node process that used a sync engine can now exit after `stop()`.

Messages still queued when a sync session ends no longer act on the next session: a stale handshake response, batch or acknowledgment is dropped, an error from a session that a new connection attempt replaced no longer ends or suspends that attempt, and a scope narrowing started by an ended session stops before hiding further rows (`applyScopeNarrowing` takes an optional `shouldContinue`).

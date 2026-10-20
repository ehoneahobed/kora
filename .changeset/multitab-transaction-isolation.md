---
"@korajs/store": patch
---

Multi-tab storage: a transaction span stays exclusive until its owner commits or rolls back. Before, an error inside a tab's transaction released the span while SQLite's transaction was still open, so another tab's write could run inside it, be acknowledged, and then be rolled back. A follower tab's transaction is now bound to the leader worker that answered its BEGIN. If the leader changes mid-transaction, the rest of it is refused with a retriable `BridgeTerminatedError` instead of autocommitting statement by statement on the new leader's worker.

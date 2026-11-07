---
"@korajs/sync": patch
"korajs": patch
---

A session the server ends with `SCOPE_CHANGED` (the access grant changed, "Reconnect to receive the new scope") now reconnects without growing the failure backoff. Since staged replication a delivery batch that was still applying when that error arrived counts for nothing and is redelivered after the reconnect, so a backoff of 8 to 16 s turned a change of access (a link expiring or being extended) into a wait of that long on a busy device. Found upgrading koradocs to the 20261107 canary.

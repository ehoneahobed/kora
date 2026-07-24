---
"korajs": patch
"@korajs/store": patch
---

Fix two convergence bugs around deleted records that could leave replicas
permanently disagreeing on whether a record exists.

A remote update landing on a tombstone was only handled when the tombstone came
from a LOCAL delete (resolved via the pairwise merge engine). A device that merely
observed a delete and then a newer update relayed from other devices kept the record
hidden (`_deleted` stayed set) while the authoring devices and the server showed it
alive — a permanent, arrival-order-dependent divergence. The same path also
materialized a resurrecting op's raw value instead of the composed atomic chain, so
increments before and after a delete were mis-counted on resurrection.

The client now resolves any remote update on a tombstone by folding the record's
whole operation log in HLC order — the same fold the server uses — so every device
agrees on whether the update resurrects the record and on its field values, and
atomic deltas on both sides of a delete compose correctly.

A stale update that loses to a newer delete is now appended to the log via a new
log-only apply (so a later fold — e.g. an atomic resurrection composing its delta —
is complete) while leaving the tombstone untouched: no zombie fields, no version
regression. Previously such an op was dropped, which could lose an atomic delta
needed by a subsequent resurrection.

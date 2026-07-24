---
"korajs": patch
"@korajs/store": patch
"@korajs/core": minor
---

Fix a lost-update bug where three or more concurrent atomic writes (`op.increment`,
`op.max`, ...) to the same field failed to converge on clients.

The client apply pipeline composed a remote atomic op through the merge engine's
pairwise rule (`base + localDelta + remoteDelta`), which is correct only for exactly
two concurrent writes from a shared base. With a third concurrent writer, the current
row already folded in an earlier remote delta, and re-deriving the value from the base
plus the local device's own delta silently dropped that earlier delta. Three devices
each incrementing a shared counter by 5, 3, and 2 could settle at 7/5/5 across devices
instead of 10.

The client now materializes atomic-op fields by folding the record's operation log in
HLC order through the same atomic-aware replay the server uses (moved into
`@korajs/core` as `replayOperationsForRecord` so both sides share one definition).
The fold composes a same-type atomic chain and resolves anything else — including a
plain set breaking the chain — by last-write-wins, so every replica converges to the
same value regardless of how many concurrent atomic writers there were or which device
authored them, including a passive device that only observes the writes. Non-atomic
fields are unaffected.

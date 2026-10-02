# Kora 1.0.0-beta.14 release notes (draft)

Draft lines collected while Phase 3 lands. Sections are append-only: add lines, do not
rewrite earlier ones; the release manager edits the final notes.

## Merge semantics

W7 Stage B1 (client): every device now computes a record with one deterministic
per-field CRDT fold (`@korajs/core` `mergeOp` / `foldRecord`). A record depends only on
the set of operations a device holds, never on their arrival order. These are
deliberate changes in what merged data means; each one was a case where replicas could
disagree permanently in beta.13.

- **Arrays are multisets merged per element occurrence.** Duplicates are kept
  (`["a", "a"]` stays two elements; removing one copy removes one). The merged order is
  the order elements were first added, not the last writer's order. A removal beats a
  device that merely kept the element (MERGE-1, NEW-MERGE-1). Two devices adding the
  same value from the same starting array add the same occurrence (one copy).
- **Objects / json merge per top-level key**; values nested under a key are replaced
  as a whole (last write wins). beta.13 recursed into nested objects pairwise.
- **Re-sending an unchanged field is not a write.** An update whose value equals its
  own `previousData` no longer wins last-write-wins for that field (all field kinds,
  not only arrays).
- **Custom resolvers** are called once per write, in HLC order, with
  `local` = the value merged so far, `remote` = the write's value and `base` = the
  write's `previousData`. They no longer need to be commutative. A throwing resolver
  falls back to the write's value and the error is reported on the merge trace.
- **Insert onto an existing record merges per field** instead of resetting the fields
  the insert does not carry.
- **`merge('server-authoritative')` lets the server win.** Writes by the server's node
  ids (sent in the handshake as `authoritativeNodeIds`) beat any device write of the
  field regardless of HLC; within a class, last write wins. beta.13 resolved it as
  plain last-write-wins.
- **`merge('counter' | 'max' | 'min' | 'append-only')` fold over every write** (base +
  every delta; extremum of every write; every add) instead of a formula over two
  concurrent writes, so three or more concurrent writers no longer lose updates.
- **`op.append` / `op.remove` on arrays** are multiset differences against the
  writer's array: appending a value that is already present adds a copy; removing
  removes every copy the writer saw.
- **An update whose insert never arrived does not materialize a row.**
- **Scope entry joins the server's fold state** (`op.foldState`), so counters,
  richtext, resolvers and arrays keep a device's concurrent edits when a record enters
  its sync scope (RT-29). Older servers that send only `fieldVersions` still work.
- **Refused operations are excluded.** When the server terminally rejects a device's
  operation, the device re-folds the record without it and converges to the server.
- **Delete vs update is unchanged**: the later of the newest delete and the newest
  write decides. A remote delete that loses to a newer local edit is now appended to
  the log (it was skipped, so the log missed it) and returns `'applied'`.
- **Re-materialization on upgrade.** The first open with beta.14 rebuilds every record
  from its log (event `store:rematerialized`, mode `log`), repairing devices that
  diverged under earlier betas; visible values can change on such devices. A compacted
  log uses the current rows as base snapshots (mode `snapshot+log`); a log with
  quarantined rows is never rebuilt from and keeps its rows (mode `kept`).
- **Compaction is safe** (STORE-14): compacted operations are folded into a per-record
  base state; delete, atomic and custom-resolver operations are kept; a compacted id
  delivered again is a duplicate by its node's contiguous acknowledged prefix.
- **`experimental.legacyMerge: true`** runs the beta.13 pairwise pipeline for this one
  beta, to compare. Switching it on or off re-materializes the database on open. It is
  removed in beta.15, together with the deprecated `MergeEngine` and `addWinsSet`.
- New store tables: `_kora_fold_state`, `_kora_fold_base`, `_kora_compacted_through`;
  new `Store` methods `getFoldState`, `isFoldMaterialized`, `setAuthoritativeNodeIds`;
  `StoreConfig.materialization`; `ApplyRemoteOptions.onMergeTraces`. The beta.13
  `ApplyRemoteOptions` (`guardRowState`, `materializeData`, `materializeTimestamp`,
  `forceMaterialize`, `logOnly`, `reactivateIfDeleted`) only apply under
  `materialization: 'legacy'`.
- **A refused write is undone on its author.** `sync:operation-rejected` / the rejected
  store still explain it, but the record no longer shows it (a refused insert disappears).
  Own writes quarantined by a scope retraction are left out too. Writes discarded from a
  held node (`discardHeld`) are NOT undone: they only stop uploading.
- **Richtext state is bounded**: a Yjs update another update of the field contains (and
  is not newer) is dropped from the field's fold state; richtext columns hold the
  canonical encoding of the merged document, byte-identical across devices.

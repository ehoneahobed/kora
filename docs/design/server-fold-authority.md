# Server fold, side effects and cross-record rules (W7 Stage B2)

## Materialization

Every server store (memory, SQLite, Postgres) keeps one fold state per materialized
record (`kora_fold_state` on SQLite and Postgres, a map in memory) and projects the
collection row from it. Applying an operation appends it, then merges it with
`mergeOp`: the cost is O(fields the operation touches), whatever the record's history
(SRV-7). The rows equal what any replica holding the same operations folds (SRV-1).

`kora_fold_state (collection, record_id, state, covered_seq, covered_op_id)`:
`state` is `serializeFoldState` output; `covered_seq` / `covered_op_id` name the
record's newest operation merged into it. An apply checks them against the record's
newest stored operation (one index probe on `(collection, record_id, delivery_seq)`):

- equal: merge the new operation only;
- the log grew without folding (an older release during a rolling upgrade): merge the
  missing tail first;
- anything else (no state, unreadable state, a state newer than the log, a field whose
  fold kind changed): re-fold the record from its log.

Postgres serializes the read-merge-write through the delivery-counter row lock that
every append already holds until commit (and `FOR UPDATE` on the state row). The fold
orders writes by HLC stamps compared in JavaScript, never by a database collation.

Server fold options: the Yjs richtext merger, no traces, and
`authoritativeNodeIds` = the store's node id plus configured extras
(`ServerStore.getAuthoritativeNodeIds()`). `KoraSyncServer.authoritativeNodeIds`
returns that list and every session advertises exactly it in the handshake (one
source of truth; there is no separate server option). Stores persist `hash_version`
(CORE-1) and the encryption envelope (`encrypted`, protocol v2) with each operation.

Envelope operations (end-to-end encryption) are folded like any other, over their
cleartext scope fields only; sealed members are never materialized. An envelope with
`data: null` creates its record (insert) and counts as a write against deletes, so the
server's record existence agrees with the devices'.

## Re-materialization migration

Runs in `setSchema` (and after a replace-mode backup import), after the W8b log
integrity scan:

- A record is re-folded when its state is missing, stale (covers another operation
  than the log's newest) or was built under another fold plan
  (`kora_server_meta.fold_plan_fingerprint`: field kinds, merge strategies, resolver
  source, fold-state version). A plan change first marks every state stale, then
  records the new fingerprint, so it is resumable.
- Batches of 500 records, one transaction each (Postgres: under the delivery-counter
  lock, so a live write on another instance is never overwritten by a stale re-fold).
- Idempotent and resumable: staleness is derived from the tables at every start; a
  restart on an up-to-date database does one aggregate read.
- Unclean log (quarantined rows): rows materialized before the fold are kept and the
  skip is logged with `console.error`; such a record folds from its remaining log on
  its next write. `getFoldMigrationReport()` reports what ran.

## Side effects (cascade, set-null)

Server-generated effects of a delete get `deriveSideEffectOpId(parentOpId,
"server/relation:<relation>:<cascade|set-null>", targetRecordId)` and the timestamp
right after the parent's (`timestampAfter`: same wall time, next logical tick, server
node). Every instance, session or retry that generates the same effect produces the
same id, and the log stores it once. A causally later write (re-pointing the child)
still wins over it.

Clients may derive ids for their own copies, but MUST NOT use the `server/` rule
namespace: a client copy has different content (node, clock, sequence), so it must be
a different operation. Both are stored; under the fold they are idempotent in effect
(two deletes, two writes of null).

## Cross-record rules (unique, capacity, referential)

One authority, the server:

1. Ingest: an operation that would violate a rule against committed state is refused
   before it is stored, judging the record as the fold would materialize it after the
   operation (`ServerStore.previewOperation`). A refused operation never enters the
   log, so no replica folds it.
2. Race: when two operations validated concurrently both commit, the post-commit
   re-check (`enforceCrossRecordRules`, run by `applyServerOperation`) emits
   corrections: ordinary operations authored by the server node, with ids derived from
   the losing write and the rule (`server/constraint:...`, `server/relation:...`), so
   concurrent detectors produce one stored correction.

Exactly one winner per conflict:

| Rule | Winner | Correction for the losers |
|---|---|---|
| unique / capacity, `last-write-wins` | newest write to the constrained fields (HLC) | undo the losing write on those fields: restore the values the record folds to without it; delete the record when that write created it or the old values still collide |
| unique / capacity, `priority-field` | highest priority, ties first-write-wins | same |
| unique / capacity, other strategies | oldest write (first-write-wins) | same |
| child written under a parent deleted with `cascade` | the delete | delete the child |
| ... with `set-null` | the delete | clear the child's reference |
| ... with `restrict`, or a restrict parent deleted while a child committed | the reference | revive the parent (an update with empty data: a write newer than the delete that changes no field) |

Only a write that could have caused the violation is re-checked (an insert, or a write
to a constrained field or a reference), so pre-existing legacy data is never
"corrected" by an unrelated write.

## Scope entry (RT-29)

A scope-entry insert carries `foldState`: the record's serialized fold state filtered
to the fields it restates. A receiver joins it with its own state (`joinStates`) and
reaches the server's value for every field kind; `fieldVersions` (now derived from the
fold) stays for older clients.

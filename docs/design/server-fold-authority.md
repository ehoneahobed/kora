# Design: server fold, side effects and cross-record rules

Every replica computes a record with one deterministic per-field fold (`foldRecord` / `mergeOp`
in `packages/core/src/fold/`). This note covers what the sync server adds on top: how it
materializes records from that fold cheaply, how it re-folds after a plan change, how it authors
side effects that every instance derives identically, how it is the single authority for
cross-record rules, and what a scope entry reveals of a record's history.

## Materialization

Every server store (memory, SQLite, Postgres) keeps one fold state per materialized
record (`kora_fold_state` on SQLite and Postgres, a map in memory) and projects the
collection row from it. Applying an operation appends it, then merges it with
`mergeOp`: the cost is O(fields the operation touches), whatever the record's history.
The rows equal what any replica holding the same operations folds.

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

Server fold options: the Yjs richtext merger, no traces, and the authority set:
every node id in the reserved `kora:server:` namespace (the prefix rule) plus the
explicit legacy ids. Every server-authored operation's node id is
`kora:server:<deploymentId>:<instanceId>`: the deployment id is persisted in
`kora_server_meta` on first start and shared by every instance of the database; the
instance id is persisted (SQLite) or drawn per start from a database counter
(Postgres, unless configured), so no two instances share a node id or its sequence
numbers. When a database that predates per-instance server ids first starts, the store records every node id whose
operations hold authority class 1 in a stored fold state (decisions folded under an
earlier, per-process server id), plus a configured plain `nodeId`, as legacy
authoritative ids; the fold plan fingerprint covers them. `KoraSyncServer.authoritativeNodeIds`
(`ServerStore.getAuthoritativeNodeIds()`) lists this instance's id, the other
`kora:server:` ids with history and the legacy ids; every session advertises exactly
it in the handshake and refuses a device presenting any of them, or any `kora:` id.
Stores persist `hash_version` and the encryption envelope (`encrypted`, protocol v2) with each
operation.

Envelope operations (end-to-end encryption) are folded like any other, over their
cleartext scope fields only; sealed members are never materialized. An envelope with
`data: null` creates its record (insert) and counts as a write against deletes, so the
server's record existence agrees with the devices'.

## Re-materialization migration

Runs in `setSchema` (and after a replace-mode backup import), after the log
integrity scan:

- A record is re-folded when its state is missing, stale (covers another operation
  than the log's newest) or was built under another fold plan. Plans are per
  collection: `kora_server_meta.fold_plan_fingerprints` maps each collection to its
  fingerprint (field kinds, merge strategies, resolver source, fold-state version,
  transforms, explicit authorities) and each `kora_fold_state.plan` is its
  collection's stamp. A plan change marks the states of the re-planned collections
  stale, then records the new fingerprints, so it is resumable; other collections are
  untouched. `fold_plan_fingerprint` (whole schema) is still recorded: it says which
  instance holds the newest plan during a rolling deploy (the outdated-record sweep
  runs only there), and a state stamped with the current whole-schema stamp is current
  in every collection (written before per-collection stamps). A database without
  per-collection fingerprints is restamped when its plan is unchanged, and fully
  re-folded once when it changed (which collections changed is not recorded).
- Batches of 500 records, one transaction each (Postgres: under the delivery-counter
  lock, so a live write on another instance is never overwritten by a stale re-fold).
- Idempotent and resumable: staleness is derived from the tables at every start; a
  restart on an up-to-date database does one aggregate read.
- Unclean log (quarantined rows): a record that owns a quarantined operation (from
  `operations_quarantine.row_json`) has an incomplete log and is never re-folded from
  it. Its base is its stored fold state, or `createSnapshotState` of its kept
  row (fields stamped at least at the quarantined operations' newest HLC); its
  remaining operations, and every later write, merge onto that base. Records with a
  complete log fold from it. `getFoldMigrationReport().skippedUnclean` counts the
  kept records; the count is logged with `console.error`.

## Side effects (cascade, set-null)

Server-generated effects of a delete get `deriveServerOpId(store, parentOpId,
"server/relation:<relation>:<cascade|set-null>", targetRecordId)` (HMAC-SHA-256 keyed
with the deployment's persisted secret: every instance derives the same id,
no client can predict it and store an operation under it first) and the timestamp
right after the parent's (`timestampAfter`: same wall time, next logical tick, server
node). Every instance, session or retry that generates the same effect produces the
same id, and the log stores it once. A causally later write (re-pointing the child)
still wins over it.

A device that applies a REMOTE delete still cascades locally (its view stays
consistent offline, and with end-to-end encryption a sealed reference is visible only
to devices). Its copy is an ordinary operation of its own node (content-hashed, its own
sequence), never in the `server/` rule namespace, but it is stamped the same way as the
server's: right after the delete (the delete's HLC, next logical ticks, the device's
node), not with the device's current time. Both copies are stored; under the fold they
are idempotent in effect (two deletes, two writes of null), and a write to the child
that is later than the delete wins over every copy, whenever each device applied the
delete. (Stamped with the device's current time instead, a late-applying device's copy would
erase such a write on every replica.)

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

## Scope entry

A scope-entry insert carries `foldState`: the record's serialized fold state filtered
to the fields it restates. A receiver joins it with its own state (`joinStates`) and
reaches the server's value for every field kind; `fieldVersions` (derived from the fold)
is still sent alongside it.

The state is redacted first (`redactFoldState`, `packages/core/src/fold/entry-state.ts`), because its reader may have no
right to the record's earlier values. Hidden array elements and hidden object keys keep
their stamps under a digest of the value, salted per record and field
(`SHA-256("kora/blind/v1", collection, recordId, field, key)`), with the value removed.
They cannot simply be dropped: a late add of a removed element must stay removed, and a
device that still holds the element from before must see it go. A replica that meets the
value in a write, or holds it in its own state, recomputes the digest and treats the entry
as that element, so folding and joining give exactly the result of the full state. A
max/min field's shadowed non-numeric value and richtext updates hidden by a reset are
dropped, since nothing can bring them back.

Devices save a full Yjs snapshot per edit, so the server's richtext state holds one per
save. The entry keeps only updates that no update of an equal or later stamp contains, the
rule a device's fold applies to its own, so a reset that arrives late hides and shows the
same content. Each kept update is re-encoded alone in a fresh document: an editor's undo
history keeps deleted text in its snapshots, and the update's own delete set removes it
there. Both steps leave every merge result unchanged.

## Known limits

What scope-entry redaction does not cover:

- A reader who guesses a removed value exactly can confirm the guess against its digest.
  The salt stops one table from serving every record, not a targeted guess.
- Counters, atomic chains and custom-resolver logs are sent whole. Their merged value
  depends on the earlier writes in order, and a device may join the state with part of the
  same history, so rewriting them changes results.
- Richtext deleted by one device stays in a later-stamped update from a device that had not
  seen the deletion, because a late reset between the two must still show that update. The
  same holds for updates written as separate deltas, which no other update contains.

Re-materialization keeps a record that owns a quarantined operation on its stored state rather
than its log, so such a record is not re-folded under a new plan until the quarantine is
resolved; `getFoldMigrationReport().skippedUnclean` counts them.

## Tests

- Materialization and re-folds: `packages/server/src/store/record-fold.test.ts`,
  `record-fold-richtext.test.ts`, `fold-plan-fingerprint.test.ts`, `per-collection-refold.test.ts`,
  `fold-migration-resume.test.ts`, `fold-migration-cost.test.ts`, `refold-rolling.test.ts`, and
  `packages/server/tests/integration/fold-materialization.test.ts`.
- Side effects: `packages/core/src/fold/side-effect-id.test.ts`,
  `packages/server/tests/integration/authored-side-effects.test.ts`.
- Cross-record rules: `packages/server/src/constraints/constraint-authority.test.ts`.
- Scope entries and redaction: `packages/core/src/fold/entry-state.property.test.ts`,
  `packages/server/tests/integration/access-delete-redaction-property.test.ts`,
  `packages/test/tests/fold-scope-entry-richtext.test.ts`.
- Convergence across devices and the server: `packages/test/tests/fold-gate/fold-gate-e2e.test.ts`.

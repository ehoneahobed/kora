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

## Protocol v2

- Protocol v2: one wire bump (decision D2) carrying the content-hash v2 ids, the encryption envelope v2 and the sequence-reservation rule. Handshakes carry `protocolVersion: 2`; see `docs/guide/sync-protocol.md` for fields, protobuf numbers (envelope 46-47, operation 14-16) and the compatibility matrix.
- Protocol v2 (CORE-1): new operations get content-hash version 2 ids (covering previousData, sequenceNumber, causalDeps and schemaVersion). `hashVersion` travels on the wire and is persisted in the client op log. The server refuses a plaintext v2 op whose id is not its content hash (`INVALID_OPERATION_ID`, non-retriable) before any schema transform; clients verify after decryption and quarantine mismatches (`sync:apply-failed`). Version-1 ops stored before beta.14 are never judged by v2 rules.
- Protocol v2 (ENC-3, NEW-ENC-1): encrypted operations use envelope v2 (`op.encrypted`, `data: null` or listed `cleartextFields`), with AES-GCM additional data binding each ciphertext to its operation, record, member and key version. Schema-aware servers store encrypted ops opaquely (the beta.12/13 `SCHEMA_VALIDATION_ERROR` on every encrypted op is gone). With encryption enabled, plaintext and protocol-1 encrypted payloads are refused unless `allowPlaintextMigration` is set. Breaking: beta.13 encrypted payloads are not readable by beta.14 (they were not readable across devices before either, ENC-1).
- Protocol v2: the envelope names its key material (`keyId`), so devices with different key material fail with a diagnosable `KEY_ID_MISMATCH`. Shared key distribution (ENC-1) is still open (Phase 4).
- Protocol v2: protocol-1 (beta.13) clients are accepted by beta.14 servers with a deprecation warning (`session.protocol_deprecated`, `sync:protocol-deprecated`) and will be refused by the next release. A beta.14 client also syncs plaintext through a beta.13 server, but encrypted sync requires a beta.14 server.
- Protocol v2: handshake responses name the server's authoritative node ids (`authoritativeNodeIds`, persisted by the client); only their operations may carry server-authored `fieldVersions`/`foldState`, which the server strips from device uploads.
- Protocol v2: new server options `authoritativeNodeIds` and `encryption: { required, allowPlaintextMigration }` (`PLAINTEXT_REJECTED`).
- Protocol v2: a SEQUENCE_CONFLICT renumbering (and a clock rebase or node rotation) of a version-2 op re-hashes it, so the renumbered op carries a new id.
- Protocol v2 (seam fixes): the handshake's `authoritativeNodeIds` is exactly what the server stores fold with (`ServerStore.getAuthoritativeNodeIds()`); the separate `KoraSyncServerConfig.authoritativeNodeIds` option drafted earlier is removed (configure extras on the store). `kora:scope-entry` is no longer listed.
- Protocol v2 (seam fixes): SQLite and Postgres server stores persist the encryption envelope (`operations.encrypted`) and `hash_version`; before, they relayed encrypted ops without ciphertext. Encrypted devices accept the server's own plaintext operations (cascades, set-nulls, corrections, route writes) when they touch only the collection's `cleartextFields`.
- Protocol v2 (seam fixes): when a SEQUENCE_CONFLICT renumbering re-hashes a version-2 op, its never-sent dependents are rewritten to name the new id (transitively); `Store.resequenceOperation` now returns `{ operation, dependents, idMapping }` and takes the rewritable ids. `replayTo` resolves a dependency on a renumbered op through `_kora_seq_conflicts`.
- **Cascades of a remote delete are stamped right after the delete** (like the server's deterministic copy), not with the receiving device's current time: a write to the child that is later than the delete (an edit, a re-point) now wins on every replica, whenever each device applied the delete. Before, a device that applied the delete late erased that write everywhere.

## Server identity and storage (Phase 3 red team, RT-61 RT-62 RT-64 RT-65 RT-70)

- **Stable server identity (RT-62), migration.** Every server store now authors its writes (route mutations, cascades, set-nulls, constraint corrections) under `kora:server:<deploymentId>:<instanceId>`. The deployment id and a derivation secret are created on first start and stored in `kora_server_meta`, shared by every instance of the database. SQLite persists its instance id; Postgres draws a fresh instance id from a database counter on every start (set `instanceId` per instance for a stable one; it must differ between running instances), so instances never collide on sequence numbers. Every `kora:server:` node id is authoritative for `merge('server-authoritative')` fields on every replica. At the first start of beta.14, node ids whose earlier decisions won such fields (per-process server ids of earlier releases, found in the stored fold states) are recorded as legacy authoritative ids and stay in the handshake's `authoritativeNodeIds`, so earlier server decisions keep winning. Breaking: the store `nodeId` option is deprecated; a plain value is no longer the authoring id but a legacy authoritative id (keep it configured on the upgrade start, or leave it: it is persisted then). A change in the legacy ids re-folds every server record once.
- **No device can act as the server (RT-61).** A handshake presenting any `kora:` node id, the server's node id or any advertised authoritative id (current or legacy) is refused with `INVALID_NODE_ID` (not retriable), over WebSocket and HTTP; HTTP long-poll sessions now deliver that final error before answering 410.
- **Every uploaded id is verified (RT-64).** An operation without `hashVersion` is verified as a version-1 content hash (`INVALID_OPERATION_ID` on mismatch); the server stores it declaring `hashVersion: 1`, and clients now verify declared version-1 ids too. Server-derived ids (cascades, set-nulls, corrections) are HMAC-keyed with the deployment secret: every instance derives the same id, and no client can predict one. Ids derived by beta.14 pre-releases are not re-derived; a later effect of the same parent may be stored a second time, which the fold treats as idempotent.
- **Postgres and SQLite store every string losslessly (RT-65).** U+0000 and unpaired UTF-16 surrogates (pasted text, a truncated emoji) are escaped in materialized rows (U+FFFF-introduced escapes; ordinary text is stored unchanged); a one-time per-table migration re-encodes existing values that contain U+FFFF. Before, a NUL dropped the Postgres session on every upload (the device re-sent it forever and none of its later writes arrived) and a lone surrogate reached peers as U+FFFD. Identifiers (operation, node, record ids, collections) holding either are refused with `INVALID_IDENTIFIER`, and any value a database still refuses is a non-retriable `UNSTORABLE_VALUE` rejection, never a dropped session. Known gap: the client SQLite store still turns a lone surrogate into U+FFFD.
- **Quarantined history is kept on the server (RT-70).** A record that owns operations the log-integrity scan quarantined keeps its pre-fold row as the base its remaining and later writes fold onto; it is no longer re-folded from the incomplete log on its next write (which dropped the quarantined effect, or the whole record).

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
- **Server authority is a property of the node id** (Phase 3, RT-61/62 client half): any operation whose node id is in the reserved `kora:server:` namespace is authoritative for `merge('server-authoritative')` fields on every replica, without the replica having to learn the id; `FoldOptions.authoritativeNodeIds` / the handshake list stays as an additional explicit list (legacy random server node ids). Devices never author under a `kora:` node id: a configured one is refused (`RESERVED_NODE_ID`), a persisted one is replaced. New core exports: `SERVER_NODE_ID_PREFIX`, `isServerNodeId`, `isAuthoritativeNodeId`, `isReservedNodeId`.
- **Scope entries without a fold state keep newer device edits** (RT-67): each restated field is stamped at exactly its own `fieldVersions` entry (a field without one at the oldest version the entry knows), never raised to the entry's timestamp; a restated `server-authoritative` value keeps the authority of the node that wrote it. A carried `foldState` of another fold plan falls back to this path.
- **Changing a field's merge kind no longer breaks the field** (RT-63): the client records a fold-plan fingerprint per collection (the server's definition, `foldPlanFingerprint` in core) and re-folds a re-planned collection on open; compacted history of a re-planned field restarts from its value at its newest write (`adaptFoldState`). An inbound operation that still hits `FoldStateError` after one re-fold is quarantined (`FOLD_STATE_INVALID`) instead of stalling the delivery stream.
- **Backups keep compacted history** (RT-66): format 2 gains the `fold_base`, `fold_snapshot` and `compacted_through` sections and the manifest flags `includesFoldState` / `compacted`; replace and merge restores on another device (also offline) keep every record and field. A file without them (beta.13) is rebuilt on its rows.
- **Row snapshots are exact where the data allows and converge** (RT-68): only the records that own quarantined log rows are kept as they are (not the whole database); a snapshot is seeded from the record's stored fold state and keeps a server-written value's authority. A row-only snapshot (pre-beta.14 compaction, beta.13 backup) still cannot fold a late write OLDER than a field's version; such records are listed by `store.getSnapshotRecords()`, the store requests one full resync, and each snapshot is dropped once the record's history is back (or its server fold state arrives in a scope entry). New table `_kora_fold_snapshot`.
- **Receiving devices no longer upload cascade copies** (RT-69): the cascades / set-nulls of a REMOTE delete are local-only provisional effects (table `_kora_provisional_ops`: never logged, sequenced or queued), retired when the server's or author's copy arrives (same parent) or when the delivery stream catches up. Only the deleting device authors and uploads its cascades. New `SyncStore.settleAfterCatchUp` hook.

## Phase 3 red team, round 2 fixes (RT-71 to RT-76)

- **`undefined` object members are absent, everywhere an id is computed** (RT-72): `createOperation` and `validateRecord` strip `undefined` members deeply before hashing and storing, and the version-2 hash treats them as absent, so the id covers exactly the JSON the op log and the wire carry. Before, an insert of `{ meta: { a: 1, b: undefined } }` was refused `INVALID_OPERATION_ID` and the record vanished from the writing device.
- **beta.13 writes with `undefined` members are accepted** (RT-71): the server rebuilds what beta.13 hashed (`undefined` as `null`): an update's cleared fields (from its `previousData` keys) and, with the schema, declared nested members. An update that cleared a field with `undefined` is stored with that field `null`, as the beta.13 client applied it, so peers converge. Any other undeclared id a protocol-1 session cannot verify is stored unverified for that session's own node (warning `session.unverified_legacy_operation`, event `sync:unverified-legacy-operation`, metric `unverifiedLegacyOperations`). Protocol-2 sessions are still verified on every upload.
- **A retried delete finishes its referential effects** (RT-73): when a delete arrives again as a stored duplicate (its batch failed after the delete committed, or was never acknowledged), the server derives any cascade or set-null still undone (or defers it to the author's copy in that batch). Memory, SQLite and Postgres stores.
- **Encrypted cascades stay applied** (RT-74; superseded by the round-3 redesign below: sealed foreign keys of enforced relations are refused, and this machinery is removed): with end-to-end encryption and a relation field not in `cleartextFields`, a remote delete's cascades and set-nulls are kept across reconnects (no longer retired at catch-up). The deleting device authors the cascades of the children it holds and, when it later receives a child it did not know, of that child too (once). Receiving devices author nothing. New `Store.setSealedRelations` (set by `createApp`); `_kora_provisional_ops` gains a `durable` column (migrated on open).
- **Devices keep every authoritative id they learn** (RT-75): the persisted list is the union of explicit (non-`kora:server:`) ids and never shrinks; `kora:server:` ids are authoritative by prefix and are no longer stored or advertised. Records re-fold only when the explicit set grows, so a reconnect after a deploy or to another instance no longer re-folds every server-authoritative record. Handshakes list only legacy and configured ids; the Postgres list no longer grows by one instance id per start.
- **The one-time legacy authority scan reads only stamp positions** (RT-76), never field values, so a json value shaped like a stamp cannot make a device a server authority.
- **Merge-mode backup imports skip server decisions**: operations of `kora:` nodes and of the device's known server authorities are not applied from a file (`RestoreResult.serverOperationsSkipped`); they arrive from the sync server.
- Docs: range filters and `orderBy` on strings containing U+0000, U+FFFF or a lone surrogate order them by the stored escape (U+FFFF), not by JavaScript order.

## Phase 3 red team, round 3 fixes (RT-77 to RT-83): root-cause redesign

- **One canonical operation body** (RT-79, RT-80, RT-83; root cause of the RT-72 family). `createOperation` puts the body in its canonical form once (`canonicalizeOperationBody`, new core export), and the version-2 id is computed over that form, so the hashed, stored, sent and folded bodies are the same by construction. Canonical form: an `undefined` member of an insert or inside an object value is absent, an `undefined` array element is `null`; **`update(id, { field: undefined })` clears the field** (written as `null`, as beta.13 applied it; before, beta.14 refused its own write `INVALID_OPERATION_ID`); a `Date` inside a json/object value is its ISO string (before, the server refused the insert and the record vanished); `-0` is `0`; binary is `{ $koraBytes }`. `Map`, `Set`, class instances, functions, `BigInt`, `NaN`, `Infinity`, invalid dates, `toJSON` objects, cycles and sparse arrays are refused at validation (`SchemaValidationError` on the field, from `NonCanonicalValueError` / `NON_CANONICAL_VALUE`, naming the path and the fix) instead of silently becoming `{}`. Breaking: values that used to be accepted and silently mangled (a `Map` in a json field) now throw.
- **beta.13 databases keep their cleared fields after the upgrade** (RT-83): every replica folds a version-1 update in its canonical form (a `previousData` key absent from `data` is a clear; `canonicalizeLegacyOperation`), so the one-time re-materialization of a beta.13 log no longer brings back a field cleared with `undefined`, and the upgraded device agrees with the server and peers. A version-1 upload whose id verifies only WITHOUT that clear (no Kora client writes it) is refused `INVALID_OPERATION_ID`.
- An insert or update with empty data (`{}`) is read back as `{}` from the op log and the wire (was `null`, which broke its id).
- Server stores keep a `t.json()` value that is a string as that string (SQLite stored it raw and parsed it back, so `"123"` became `123`; Postgres refused non-JSON strings).
- **A duplicate must be the same operation** (RT-77, security): an upload that reuses the id of a stored operation is acknowledged as a duplicate only when every field the stored id covers is equal; otherwise it is refused `FORGED_DUPLICATE` (not retriable) with no effect, logged (`session.forged_duplicate`), emitted (`sync:forged-duplicate`) and counted (metric `forgedDuplicates`). A re-sent delete re-checks its referential effects from the STORED delete only. Before, a re-sent id typed as a delete of any live record made the server cascade its children, bypassing validators and the rate limit.
- **Breaking (encrypted apps): enforced foreign keys must be cleartext** (RT-74, RT-78, RT-82 redesign). With sync encryption enabled, the foreign key of every relation whose `onDelete` is `cascade`, `set-null` or `restrict` must be listed in `cleartextFields`; `createApp` refuses a sealed one at startup with `SealedRelationFieldError` (`SEALED_RELATION_FIELD`), naming the field and the fix (or use `onDelete: 'no-action'`). Cascades then work exactly as without encryption (the server enforces them for every device). The device-side machinery of the round-2 fix is removed: no durable provisional effects (the `durable` column is unused; existing tables keep working), no late cascades authored by the deleting device, no `Store.setSealedRelations`. Encrypted sync never worked across devices before ENC-1 (per-device key material), so no working deployment relied on device-side cascades.
- **Authority over time, and explicit revocation** (RT-81). Every explicit id a deployment ever held authoritative (a configured `authoritativeNodeIds` extra, a legacy server id) is persisted, stays authoritative on the server until revoked (exactly as devices keep it), and is refused at handshake as a device node id for good. Removing an id from `authoritativeNodeIds` does not revoke it: list it in the new store option `revokedAuthoritativeNodeIds` (memory, SQLite, Postgres). Revocation is permanent; the handshake response advertises it (`revokedAuthoritativeNodeIds`, protobuf envelope field 48), and devices drop the id from their union, never learn it again, and re-fold affected records. `Store.setAuthoritativeNodeIds(nodeIds, revokedNodeIds?)`.

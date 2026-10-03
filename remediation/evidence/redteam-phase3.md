# Phase 3 red-team review (2026-10-02)

Independent adversarial review of `fix/phase3-one-fold` at 959b791. Scope: the one deterministic fold (W7), durability (W8b), protocol v2 and envelope v2 (W9). Every finding has a repro under `tests/repro/` that fails at 959b791. Each is tracked in `remediation/tracker.json` as RT-61..RT-70 (status open, phase 3).

Method:
- Executable repros against the real `KoraSyncServer` and `ClientSession`, `TestDevice` (real SQLite store and `SyncEngine`), `createApp` and `Store`, with in-memory transports.
- Server stores used: memory, SQLite and Postgres 16 (own instance, UTF8, `C.UTF-8`).
- The fold library was also attacked directly (`foldRecord`, `mergeOp`, `createSnapshotState`).
- Mixed versions ran against a real beta.13 build (33bca46) over WebSockets.
- Gates: the fold gate on 400 new seeds, `chaos:nightly`, `check.mjs --all` and `test:release-gate` (results below).

| ID | Sev | Finding | Location | Required fix | Repro |
|---|---|---|---|---|---|
| RT-61 | P1 (security) | A device can hand-shake with the server's own node id and then write `merge('server-authoritative')` fields as the server. The handshake publishes that id in `authoritativeNodeIds`, and the session reserves only the `kora:` prefix. The claim rule refuses a node only when it has stored history and no owner, so a server node that has not written yet can be claimed. That covers every new deployment, and every restart while node ids are auto-generated (RT-62). The forged node's writes beat device writes and earlier server decisions, on the server and on every device. By code reading: on Postgres its sequence numbers also collide with the server's cached counter, so the server's own side effects and corrections fail with `SEQUENCE_CONFLICT`; under encryption, its plaintext cleartext-only ops are accepted without decryption. | `server/src/session/client-session.ts:1773, 1834, 2075`; `core/src/fold/fold.ts:183`; `server/src/store/postgres-server-store.ts:208`; `sync/src/engine/sync-engine.ts:2942` | Refuse at handshake any id in `getAuthoritativeNodeIds()` or any id the store authors under. Pre-claim the server node ids at startup. Refuse uploads whose `nodeId` is authoritative. | `packages/server/tests/repro/RT-61.test.ts` |
| RT-62 | P1 | Server node ids are generated per process by default, and the docs say "usually left to auto-generate". After a restart the handshake advertises a new authoritative list. Devices replace their persisted list and re-fold, so every earlier server write loses its authority on the devices. The server's fold states keep it, because its plan fingerprint does not include the authoritative ids. In the repro the server shows `approved` while the old device and a new device show `client`. Several instances on one Postgres database each advertise only their own id. The alternative, one configured id shared by all instances, makes them collide on the server node's sequence numbers: the second instance's route writes get `SEQUENCE_CONFLICT`. So no multi-instance configuration is correct. By code reading: encrypted devices also quarantine every plaintext op from an earlier server process (cascades, corrections), because the cleartext exemption keys on the current list. | `server/src/store/{memory,sqlite,postgres}-server-store.ts:135/157/180`; `docs/guide/storage-configuration.md:119`; `store/src/store/store.ts:998`; `server/src/store/record-fold.ts` (`foldPlanFingerprint`); `postgres-server-store.ts:208` | Persist the server node id in the database on first start and share it across instances. Allocate server sequence numbers from the database, under the delivery-counter lock. Keep authority stable: devices union the ids they learn instead of replacing them. Include the authoritative set in the fold plan fingerprint on both sides. | `packages/test/tests/repro/RT-62.test.ts`, `packages/server/tests/repro/RT-62-shared-node.test.ts` (Postgres) |
| RT-63 | P1 | The client fold has no plan fingerprint. A device re-materializes once per database. After a schema change that changes how a field folds (`merge('counter')`, append-only, a new resolver), every existing record keeps a fold state of the old kind. `mergeOp` then throws `FoldStateError` on every later write to that field. Local writes fail. By code reading: a remote op that touches the field stalls the device's whole delivery stream, because this apply error counts as transient. The server re-folds on a plan change, so devices and the server diverge. | `core/src/fold/fold.ts:150, 412`; `store/src/store/store.ts:960`; `sync/src/engine/sync-engine.ts:2831` | Persist the client's fold plan fingerprint (same definition as the server's) and re-fold affected records on open when it changes. Treat `FoldStateError` on apply as a re-fold of that record, never as a stall. | `kora/tests/repro/RT-63.test.ts` |
| RT-64 | P2 | A protocol-2 client can omit `hashVersion`. Version-1 ids are verified nowhere: not on the server, not on clients. Stores deduplicate by id alone. Some server-derived ids are predictable to the writer: the cascade-late correction (parent delete id plus the writer's own op id) and unique/capacity corrections (the losing write's HLC). A writer can store any op under such an id first. The server's correction is then dropped as a duplicate. In the repro, a comment written under an already deleted cascade parent survives. The control run without the squat op deletes it. | `server/src/session/client-session.ts:2689`; `sync/src/engine/verify-inbound.ts:53`; `server/src/store/memory-server-store.ts:182`; `server/src/constraints/constraint-authority.ts:196, 337` | Require `hashVersion: 2` from protocol-2 sessions and verify it; accept version 1 only from protocol-1 sessions. Verify version-1 ids too. Never let a client op occupy a server-derived id: dedup derived ops by `(nodeId, id)`, or refuse client ids in the derivation domain. | `packages/server/tests/repro/RT-64.test.ts` |
| RT-65 | P1 (not a Phase 3 regression) | The Postgres server store cannot hold a string with U+0000 or a lone UTF-16 surrogate. TEXT refuses NUL; the materialized JSONB columns refuse both escapes. A NUL from user input drops the session on every upload. The device re-sends it forever, and no later write of that device ever reaches a peer; the client only sees `server disconnected`. A lone surrogate reaches peers as replacement characters, with no error. SQLite and memory stores keep both values. | `server/src/store/materialization.ts:37-41`; Postgres collection rows | One encoding at the Postgres boundary that round-trips every JS string. For anything a store still cannot hold, a surfaced non-retriable refusal, never a session drop that loops. | `packages/test/tests/repro/RT-65.test.ts` (Postgres) |
| RT-66 | P2 | Restoring a compacted device's backup on another device (replace mode) loses compacted history. The backup carries no fold base states, and the restoring device clears its own. It then judges the log clean from its own meta: it never compacted, and gaps are only checked for its own nodes. So it rebuilds with mode `log`. A record whose insert was compacted disappears; fields whose last write was compacted revert. Sync brings them back (the restore resets delivery to 0). An offline restore, or a disaster-recovery restore, keeps the loss. | `store/src/backup/restore.ts:126-133`; `backup.ts` (no base export); `store/src/store/store.ts:2502-2509, 965-970`; `log-integrity/log-integrity.ts:229-231` | Export and import the fold base states. At least, mark a restored log `snapshot+log` when the backup's source compacted. | `packages/store/tests/repro/RT-66.test.ts` |
| RT-67 | P2 (mixed versions / fallback) | A scope entry that carries no fold state loses its per-field versions in the fold. `fieldWriteStamp` takes `max(fieldVersion, op stamp)`, and the op is stamped at the record's latest version. Every restated field is therefore written at the newest write of any field, and it beats a device's concurrent offline edit. The device then diverges permanently from the server, which folds that edit. Paths: a beta.13 server, a store without fold state, or an unreadable carried state (another `FOLD_STATE_VERSION`). | `core/src/fold/fold.ts:164-177, 196-207`; `server/src/session/client-session.ts:3375` | Stamp each restated field at exactly its own version. | `packages/core/tests/repro/RT-67.test.ts` |
| RT-68 | P2 | Row-based base snapshots drop late concurrent writes. This is the documented "approximate" path; the repro constructs the divergence. Snapshots are used after a pre-W7 compaction (`snapshot+log`), on a `FOLD_STATE_VERSION` bump with a compacted log, and in `kept` mode. `kept` applies whenever the log has any quarantined row, and then every record of the database becomes a snapshot. A late offline write older than a field's version is folded by every replica except the snapshot one: counter deltas, array adds, richtext updates. In the repro every replica shows stock 14 and tags `[x, z, y]`; the snapshot replica keeps 15 and `[x, y]` for good. By code reading: snapshot stamps carry no authority class, so a server-authoritative value whose winning server write is older than a device write flips when that device write is merged again. | `core/src/fold/snapshot.ts:110-137`; `store/src/fold/rematerialize.ts:84-96`; `store/src/store/store.ts:965-970` | Re-bootstrap such records from the server's fold state (a scope entry carries `foldState`). Limit `kept` to records that own a quarantined row. | `packages/core/tests/repro/RT-68.test.ts` |
| RT-69 | P2 | Every device that applies a remote cascading delete stores and uploads its own copy of every cascade (own node, own id). In the repro, 4 devices and 20 children stored 100 child deletes, and a fifth device that synced later added 20 more. The cost grows without bound as devices join. Copies from users without write grants on the children are refused as terminal rejections. | `kora/src/apply-pipeline.ts:301-320` | Keep a receiving device's cascades of a remote delete local: fold them, never enqueue them. Or derive their id and content identically on every device. | `packages/test/tests/repro/RT-69.test.ts` |
| RT-70 | P2 | On an unclean server log (quarantined rows), the upgrade keeps pre-fold rows "until their next write". That next write re-folds the record from the remaining log. The quarantined op's effect vanishes, and a record whose insert was quarantined disappears from the server, and from devices that enter it later. | `server/src/store/sqlite-server-store.ts:1214-1217` (Postgres the same) | Build the record's base from its kept row and fold later writes onto it, or refuse writes to records with quarantined history until an operator repairs them. | `packages/server/tests/repro/RT-70.test.ts` |

## What held up

- **The fold itself.** `mergeOp` was attacked kind by kind: register atomic chains interleaved with plain writes, the occurrence-indexed element multiset (duplicates, concurrent removes, re-adds after removal, reorders), key maps with removal markers, counters, extrema, the resolver log (including throwing resolvers and their error fields), and richtext with a reset register and pruning by subsumption. Each is commutative and idempotent over sets, and `joinStates` agrees with folding the union. The server folds richtext without `richtextSubsumes`, so server and client states differ while materializations are equal. That is harmless.
- **The fold gate on 400 new seeds** (seed base 777001) passed all four tests: every field kind; server-authoritative writes with the server converging; end to end encrypted; and the beta.13 pipeline is still rejected.
- **Exclusion of terminally rejected ops.** A device re-folds without the refused op and reaches the server's state, even when rejections arrive after dependent writes, because the fold is a function of the op set.
- **Compaction under the fold** is exact. Bases are fold states, the contiguous acknowledged prefix holds back quarantined or missing ops, and a late op after compaction converges. The loss is only on a cross-device restore (RT-66).
- **Ingest stripping.** `fieldVersions` and `foldState` are stripped from every device upload. `kora:` node ids are refused at handshake. Each uploaded op must carry the session's node in both `nodeId` and `timestamp.nodeId`. beta.13 decoders drop `foldState` (field 15), so it cannot be smuggled through an old server.
- **Envelope v2.** The AAD binds node, record, type, HLC, sequence, member, key version and hash version, so moving a ciphertext to another record or op fails. A malformed envelope is dropped and the op is then refused as plaintext. The client checks the id after decryption.
  - Not filed (P3, by code reading): cleartext scope fields are not authenticated against the sealed values. A member of the encryption group can make the server's cleartext (used for scopes and constraints) differ from what devices decrypt. This affects only that member's own records.
- **Mixed versions against the real beta.13 build.**
  - `protocol-v2-compat.mjs` passes both scenarios.
  - An extended probe also passes: concurrent atomic increments (3 and 2 writers, offline), array edits and a delete. It ran three ways: v2 clients through a beta.13 server, and a beta.13 client next to a v2 client through a v2 server, in both roles. All replicas converged to `n = 23`, with nothing quarantined and nothing rejected.
- **Wire fidelity through SQLite and Postgres.** Floats, -0, large integers, nested JSON, duplicate array elements, empty strings and timestamps all verify (hash v2) and converge on both stores. The only failure is RT-65.
- **Chaos.** `chaos:nightly` passed: 10 clients × 1,000 ops under 10% drop and 5% duplicate, plus the no-silent-loss invariants on 11 seeds.
- **Regression.**
  - `check.mjs --all` ran with Postgres 16, real Chromium and `LMS_OPS=20000`. Result: 146/180 fixed, 0 errors, 0 warnings. No regression, and every failing repro is owned; the ten new entries fail as intended.
  - `test:release-gate` passed: production path, sync reconnect, real-path chaos and the benchmark gates.

## Not attacked

- Real Chromium (OPFS and IndexedDB) for the new fold tables. It was covered only by the `check.mjs --all` browser suites.
- HTTP long-poll transport specifics under protocol v2.
- DevTools traces of fold decisions.
- Key rotation across `keyVersion`, and shared key distribution (ENC-1, Phase 4).
- Concurrency races between two Postgres instances during the startup re-materialization.
- `unassignedWrites: 'assign-to-first-user'` combined with migrations' backfill ops.
- An interrupted `importBackup`.
- Performance gates beyond `test:release-gate`.

# Round 2 (2026-10-03)

Independent adversarial review of `fix/phase3-one-fold` at 4d6c8a7, covering the round-1 fixes (`git log 827adc9..4d6c8a7`). Scope:
- server identity and the `kora:server:` prefix authority;
- legacy authoritative ids;
- keyed server-derived ids and version-1 verification;
- the stored-text codec on server and client stores;
- RT-63: fold-plan re-fold and the `FOLD_STATE_INVALID` quarantine;
- RT-66: backups with fold state;
- RT-67: per-field stamping;
- RT-68: snapshots and settling;
- RT-69: provisional cascades and server-side deferral;
- RT-70: quarantine-based rebuild.

Method:
- Executable repros against:
  - the real `KoraSyncServer` and `ClientSession` (memory, SQLite and Postgres 16 stores);
  - `TestDevice` networks (real SQLite store and `SyncEngine`, including encrypted networks);
  - `Store`.
- A real beta.13 build (33bca46) over WebSockets against this tree's server (`scripts/remediation/rt-legacy-id-probe.mjs`).
- Own Postgres 16 (`initdb -E UTF8 --locale=C.UTF-8`, port 54407).
- Gates rerun (results below).

Every finding has a repro under `tests/repro/` that fails at 4d6c8a7. Each is tracked as RT-71..RT-76 (status open, phase 3).

| ID | Sev | Finding | Location | Required fix | Repro |
|---|---|---|---|---|---|
| RT-71 | P1 | The strict version-1 id check (RT-64 fix) refuses legitimate beta.13 writes. beta.13 hashes an `undefined` object member as `"key":null`. The op log and the wire are JSON, so the member is gone when the server recomputes the hash. `update(id, { assignee: undefined })` and object values with an `undefined` member are refused `INVALID_OPERATION_ID` (terminal). The beta.13 client keeps the value; no peer ever sees it. Against the real beta.13 build, 3 of 4 ordinary write shapes were refused. Increments, numbers (`1e21`, `-0`, `5e-324`), unicode, key order, timestamps and arrays verify. Memory and Postgres stores behave the same. | `server/src/session/client-session.ts:2846-2852`; `sync/src/engine/verify-inbound.ts:123-144`; beta.13 `canonicalize` and `validateRecord` | Accept the beta.13 hash form by rebuilding the `undefined` members (for an update, every `previousData` key absent from `data`; for objects, the declared nested fields). Or accept an unverifiable version-1 id from a protocol-1 session as unverified (derived ids are keyed now), and dedup client ops by `(nodeId, id)`. | `packages/server/tests/repro/RT-71.test.ts`; `scripts/remediation/rt-legacy-id-probe.mjs` |
| RT-72 | P1 (not a round-2 regression) | A beta.14 device's insert whose object field holds an `undefined` member (`{ a: 1, b: undefined }`) is refused `INVALID_OPERATION_ID`, and the record vanishes from the writing device. The version-2 hash covers `"b":null`; the uploaded JSON has no `b`. Top-level `undefined`, and nested `undefined` in an update, are normalized elsewhere and pass. | `core/src/operations/content-hash.ts:141-160`; `core/src/schema/validation.ts` (nested members checked only when present) | Strip `undefined` members deeply before hashing (`createOperation`, `validateRecord`), so the hashed content is the JSON content. Treat an `undefined` member as absent in version-2 canonicalization. | `packages/test/tests/repro/RT-72.test.ts` |
| RT-73 | P2 | A cascade the server deferred to the end of an upload batch (RT-69 residual, fb5dcae) is lost if the batch fails after the delete committed. The deferred list lives only in memory. The retried delete is a stored duplicate, so it derives nothing. If the author's copy is then refused on the retry (no write grant on another user's child, a validator, an invalid id), the child stays an orphan of a deleted parent, on the server and on every device. In the control run without the transient failure, the child is deleted. | `server/src/apply/apply-server-operation.ts:207-220`; `server/src/session/client-session.ts:2392, 2636-2647, 2691` | Make the deferral durable or self-healing. Either record pending effects in the delete's transaction (an outbox plus a startup sweep), or have a duplicate delete re-check its effects and derive any that no stored copy covers. | `packages/server/tests/repro/RT-73.test.ts` |
| RT-74 | P2 | Under end-to-end encryption with the relation field sealed, the server cannot cascade; the sync-encryption guide says "each device cascades for itself". Since RT-69, a device applies a remote delete's cascades only provisionally, and `settleAfterCatchUp` retires every pending provisional effect. If the deleting device never saw the child, nobody makes the cascade durable. On B the child disappears, then comes back after the next reconnect and stays. Before the RT-69 fix, B authored a durable copy. | `kora/src/apply-pipeline.ts:172-186`; `store/src/store/store.ts:1199-1213`; `docs/guide/sync-encryption.md:254` | When the server cannot derive the effect, author the receiving device's cascade as a real operation with a deterministic id (`deriveSideEffectOpId(parent, rule, target)`, identical on every device, so copies dedupe). Or never retire a provisional effect the server is known not to derive. | `packages/test/tests/repro/RT-74.test.ts` |
| RT-75 | P2 | Devices replace their authoritative ids with each handshake's list; the union the RT-62 fix required is not implemented. The list differs per instance: its own `kora:server:<d>:<i>` (new on every Postgres start), the `kora:server:` ids it loaded from `sync_state` (one more per start that wrote), and the legacy ids it loaded at its start. So every reconnect after a deploy, or to another instance, re-folds every record of every collection with a server-authoritative field. In the repro, 50 records were re-folded 100 times, for ids that are authoritative by prefix anyway. An explicit authority that an instance does not list is also dropped: a legacy server's approval flips to a later device write on that device. | `store/src/store/store.ts:1292-1318`; `store/src/fold/record-folder.ts:149`; `sync/src/engine/sync-engine.ts:1778-1782, 1840-1843`; `server/src/store/postgres-server-store.ts:2228-2231` | Persist the union of learned explicit ids. Compare only explicit (non-`kora:server:`) ids, and re-fold only when the explicit set grows. | `packages/store/tests/repro/RT-75.test.ts` |
| RT-76 | P3 | The one-time legacy authority scan walks the whole fold-state JSON, values included. A json value holding `{ c: 1, t, o: <op id> }` makes the named op's node a server authority: its writes win server-authoritative fields, and its own handshake is then refused. Only databases that already hold fold states at their first beta.14 start (from a pre-release fold build) are exposed. | `server/src/store/server-identity.ts:210-233`; `sqlite-server-store.ts:280`; `postgres-server-store.ts:359` | Deserialize each state and collect only stamp positions, never values. | `packages/server/tests/repro/RT-76.test.ts` |

## What held up (round 2)

- **The prefix authority.**
  - `kora:server:` is checked case-sensitively, by `startsWith`, on every replica.
  - No layer normalizes node ids: Postgres runs `C.UTF-8`, and node ids do not go through the stored-text codec. Case variants and look-alike prefixes are ordinary device ids everywhere.
  - The handshake refuses `kora:` ids, the store's id and every advertised id; uploads are re-checked per op (`checkUploadIntegrity`).
  - A device cannot make a scope entry restate a value under a server stamp: `fieldVersions` and `foldState` are stripped from uploads, and an op's `timestamp.nodeId` must be the session node.
- **Identity under concurrency.**
  - The deployment id, the derivation secret and the Postgres instance counter are created under one advisory transaction lock (`setOnce` plus `UPDATE ... RETURNING`). Concurrent first starts share one secret and draw distinct instance ids.
  - The secret is read only into the store. It is not in backups, devtools events, logs or handshakes.
  - Server-derived ids are HMAC-keyed and identical across instances.
- **Version-1 verification for ordinary values (beta.13 build).** Verified: increments (`atomicOps`), floats, `1e21`, `-0`, `5e-324`, supplementary-plane and line-separator characters, nested key order, timestamps, and arrays with duplicates. Only `undefined` members fail (RT-71).
- **The stored-text codec.**
  - It is injective and round-trips.
  - Equality, `$in`, relation lookups and the server's `buildWhereClause` bind the encoded form on both sides.
  - Record ids are not encoded on either side, so FK lookups agree.
  - Every row deserializer the app reaches decodes. JSON columns and op data need no codec.
  - The Postgres and SQLite one-time migrations run per table, with a marker (and an advisory lock on Postgres), so concurrent starts do not double-encode.
- **The fold gate on 400 new seeds** (seed base 990001) passed all four tests: every field kind; server-authoritative writes with the server converging; end to end encrypted; and the beta.13 pipeline is still rejected.
- **RT-69 deferral, normal path.** Rate-limited and refused author copies are derived after the batch. RT-73 needs a failure after the delete committed.
- **Provisional cascades without encryption.** When the deleting device later receives a child it did not know, it authors the cascade itself. B's provisional effect is retired by the author's copy (through the causal dependency), and the state converges.
- **Gates.**
  - `check.mjs --all` ran with Postgres 16, real Chromium and `LMS_OPS=20000`. Result: 156/180 fixed, no regression, no guard failure. The only errors were this round's new repros, before they were mapped.
  - `chaos:nightly` passed: 10 clients × 1,000 ops under 10% drop and 5% duplicate, plus the no-silent-loss invariants (11/11).
  - `test:release-gate` passed: production path, sync reconnect, real-path chaos and the benchmark gates.

## Not filed (P3 or below, by code reading)

- Range filters and `orderBy` on encoded strings put strings containing U+0000, a lone surrogate or U+FFFF after all ordinary text. The codec doc only promises unchanged ordering for ordinary text.
- A beta.13 backup's rows hold raw U+FFFF. A replace restore inserts them verbatim into a migrated database, so a value containing U+FFFF followed by `0`, `F` or `s` decodes differently. The backup `records:` sections carry the encoded form.
- A merge-mode backup import applies the file's operations through the remote-apply path, including operations under a `kora:server:` node. A crafted file can therefore make a value authoritative on the importing device only; it is never uploaded.
- Two Postgres instances fold with different authority sets when only one has extra `authoritativeNodeIds` configured, or a plain `nodeId` added. The fold-plan fingerprint is checked only at startup.

## Not attacked (round 2)

- HTTP long-poll transport specifics, and DevTools traces of fold decisions.
- Key rotation across `keyVersion`, and shared key distribution (Phase 4).
- An interrupted `importBackup`, and a merge-mode import while sync is running (snapshot settling without a real full resync).
- `FOLD_STATE_INVALID` quarantine replay when the re-fold fails again.
- Real Chromium beyond the `check.mjs --all` browser suites.
- Performance of the RT-70 rebuild and of re-folds on large databases, beyond the release-gate benchmarks.

# Round 3 (2026-10-03)

Independent adversarial review of `fix/phase3-one-fold` at 97981a7, covering the round-2 fixes (`git log 07e4f45..ffe0893`):
- deep stripping of `undefined` members before version-2 hashing and validation (RT-72);
- version-1 verification that rebuilds beta.13's hash forms, cleared fields stored as `null`, and unverified acceptance of protocol-1 ops for their own node (RT-71);
- the server's duplicate-delete re-check (RT-73);
- durable provisional cascades for sealed relations, and author-side cascades for late-known children (RT-74);
- the client's union of explicit authoritative ids, with servers advertising explicit ids only (RT-75);
- the stamp-position-only legacy authority scan (RT-76), and merge import skipping server ops.

Method:
- Executable repros against:
  - the real `KoraSyncServer` and `ClientSession` (memory, SQLite and Postgres 16 stores);
  - `TestDevice` networks (real SQLite store and `SyncEngine`), including encrypted networks with sealed relations and server validators;
  - `Store`.
- A real beta.13 build (33bca46, rebuilt into a private temp dir) against this tree, with four scripts:
  - `rt-legacy-id-probe.mjs`;
  - `protocol-v2-compat.mjs`;
  - `rt3-legacy-probe.mjs` (new): six more write shapes;
  - `rt3-upgrade-clear-probe.mjs` (new): beta.14 opens a beta.13 database.
- The pre-fix tree (07e4f45) was built separately to tell regressions from older defects.
- Own Postgres 16 (`initdb -E UTF8 --locale=C.UTF-8`, port 54409).
- Gates rerun (results below).

Every finding has a repro under `tests/repro/` that fails at 97981a7. Each is tracked as RT-77..RT-83 (status open, phase 3).

| ID | Sev | Finding | Location | Required fix | Repro |
|---|---|---|---|---|---|
| RT-77 | P1 (security) | Regression of the RT-73 fix. The duplicate-delete re-check derives the referential effects of the UPLOADED op, not of the stored delete. `isStoredDuplicate` matches on id and node only (own node: any sequence; another node: the same sequence). It runs before `checkUploadIntegrity`, so the body is never compared or verified. A device re-sends the id of any stored op it knows (its own, or a delivered op of another node) as `type: 'delete'`, with any collection and record id. The server then derives server-authored cascade deletes and set-nulls for every child of that LIVE record that the device's uplink scopes allow, and relays them. No validator runs (duplicates skip it), and the rate limiter is not charged. In the repro, the app's validator refuses every delete by the attacker. Both comments of a live post are deleted anyway, on memory and on Postgres. | `server/src/session/client-session.ts:2425-2440, 2772-2792, 3466-3471`; `server/src/apply/apply-server-operation.ts:252-283` | Re-check only the stored delete: load the stored op (by id and node) and use its content. Ack a duplicate whose body differs from the stored op without any effect, or refuse it. | `packages/server/tests/repro/RT-77.test.ts` |
| RT-78 | P2 (data loss) | Regression of the RT-74 fix. The setting is end-to-end encryption with a sealed relation. `cascadeLateChildOfOwnDelete` runs after every applied remote op, so the deleting device authors the late cascade right after applying a late child's insert. That is before the same batch moves the child to a live project. The copy is stamped now, so it beats the move everywhere. In the repro, B had moved the todo to project Q and shows it there. When A reconnects, the todo is deleted on A and on B. Without encryption, the server's cascade-late correction reads the folded child and the todo survives (control test). | `kora/src/apply-pipeline.ts:135-138, 211-256` | Judge late children on the folded state after the delivered batch (or at catch-up), and cascade only if the child still references the deleted parent. Never stamp the copy after a move it did not see: stamp it like the receivers' effect, right after the delete. | `packages/test/tests/repro/RT-78.test.ts` |
| RT-79 | P1 (not a round-2 regression) | Same class and outcome as RT-72. A `Date` inside a `t.json()` value passes validation. The version-2 canonical form walks `Object.entries(date)`, which is empty, so the id covers `{}`. The op log and the wire carry the ISO string. The server refuses the insert `INVALID_OPERATION_ID` (terminal), and the record vanishes from the writing device. The round-2 rule "the hashed content is exactly the JSON content" holds only for `undefined`. `Map` and `Set` are accepted too, and silently become `{}`. Same at 07e4f45. | `core/src/operations/content-hash.ts:117-132`; `core/src/schema/validation.ts`; `core/src/operations/strip-undefined.ts` | Hash the JSON round trip of op data (binary kept in its canonical form), or refuse non-plain objects in json and object values at validation. | `packages/test/tests/repro/RT-79.test.ts` |
| RT-80 | P3 | `update(id, { field: undefined })` with only `undefined` members is refused `INVALID_OPERATION_ID` ("altered after it was created"). The stripped data `{}` is hashed, but the store's op log reads an empty data object back as `null`. No replica clears the field. A beta.13 client's same call clears it, and the server stores that as a clear (RT-71). Same at 07e4f45. The round-2 register said top-level `undefined` in an update passes. | `core/src/operations/operation.ts` (`normalizeOperationInput`); `store/src/serialization/serializer.ts:186`; `store/src/mutations/write-ops.ts:165-189` | Decide what the call means: clear (as beta.13 did) or ignore. If ignored, drop the key from `previousData` and write no op. Never hash a data shape the log does not round-trip. | `packages/test/tests/repro/RT-80.test.ts` |
| RT-81 | P3 | The authority union (RT-75) has no revocation, and the server forgets what it advertised. Devices keep every explicit id for good. The handshake refuses only ids the server lists now, and an id with no history can be claimed. An operator may remove a configured `authoritativeNodeIds` extra, to revoke it or on one instance of several. A device can then hand-shake with that id. Its server-authoritative writes win on every device that learned the id, but are ordinary writes on the server. | `store/src/store/store.ts` (`setAuthoritativeNodeIds`); `sync/src/engine/sync-engine.ts:1840-1853`; `server/src/session/client-session.ts:2994-2999` | Persist every id the deployment ever advertised, and refuse it at handshake for good. Give operators an explicit, versioned revocation instead of a union only. | `packages/server/tests/repro/RT-81.test.ts` |
| RT-82 | P2 | Regression of the RT-74 fix. The setting is end-to-end encryption with a sealed relation. A receiver's cascade is a durable provisional effect, and only the deleting device's real copy retires it. If the server refuses that copy, nothing ever retires the effect. The server refuses it when the deleting user has no write grant on another user's child, or when a validator refuses it. The deleting device excludes its refused copy and shows the child, and the server keeps it. The receivers keep it deleted, across reconnects. In round 2, before the RT-74 fix, replicas agreed. | `kora/src/apply-pipeline.ts:181-197`; `store/src/store/store.ts` (`settleAfterCatchUp`); `RecordFolder` provisional retirement | Make a terminal refusal of the copy reach the receivers (a relayed marker or an authored retraction), or retire durable effects when the server reports the delete resolved. | `packages/test/tests/repro/RT-82.test.ts` |
| RT-83 | P1 | Upgrading a beta.13 database to beta.14 brings back every field the user cleared with `undefined`. beta.13 wrote NULL to the row but logged JSON without the member. beta.14's one-time fold materialization rebuilds rows from the log. The server stores the same op with the field `null` (RT-71). The upgraded device already holds that id, so it never applies the server's copy and diverges from the server and every peer for good. Confirmed with the real beta.13 build: `update(id, { assignee: undefined, title })` and `update(id, { assignee: undefined })` both revert; nested members do not. | `store/src/store/store.ts:1055` (`ensureMaterialization`); `store/src/fold/rematerialize.ts`; `sync/src/engine/verify-inbound.ts` (`restoreUndefinedFromPrevious`, server only) | Apply the server's rebuild when folding a local undeclared (version-1) update: every `previousData` key absent from `data` is a clear. Or rewrite those log rows once at the upgrade (same version-1 id). Add an upgrade test from a real beta.13 database. | `packages/store/tests/repro/RT-83.test.ts`; `scripts/remediation/rt3-upgrade-clear-probe.mjs` |

## What held up (round 3)

- **Version-1 verification against the real beta.13 build.**
  - `rt-legacy-id-probe.mjs`: all 6 cases accepted and converged with a beta.14 peer.
  - `rt3-legacy-probe.mjs` adds six shapes: increment plus `undefined` in one update; only `undefined`; `null`; a json field set to `undefined`; an array field cleared with `undefined` plus increment; nested `undefined` on insert and update. All were accepted and converged.
  - `protocol-v2-compat.mjs` passes both scenarios.
  - Cleared fields stored as `null` give one result on beta.13 and beta.14 peers. The only divergence is the writer's own upgrade (RT-83).
- **Undefined stripping on beta.14 writers.**
  - Consistent on every replica: nested `undefined` in inserts and updates; `-0`; `Map`, which becomes `{}` everywhere (noted under RT-79).
  - Refused at validation: NaN, Infinity, functions, `toJSON` objects, sparse arrays and `undefined` array elements.
  - Only `Date` (RT-79) and the update with only `undefined` members (RT-80) break.
- **Unverified protocol-1 acceptance.** It is limited to the session's own node, and a protocol-2 session never reaches it. Server-derived ids are HMAC-keyed on every built-in store; on Postgres, derivation waits for the loaded secret. Clients skip undeclared ids, consistently with the server. A downgraded device gains nothing it cannot write directly:
  - restoring `previousData` keys as `null` is the same as writing `null`;
  - colliding with another node's future op needs that op's exact content and HLC;
  - a stored id of another node is a no-op duplicate on the apply path.
  RT-77 needs no downgrade.
- **beta.13 encrypted clients** are refused `PLAINTEXT_REJECTED` by a beta.14 server that requires encryption. The beta.14 notes document this (envelope v1 is unreadable); not a finding.
- **The RT-73 re-check on the honest path.** `stored-delete-effects` and `legacy-undefined-members` pass on Postgres 16. Derived ids are keyed and deterministic, so concurrent retries on two instances store one copy (by code reading).
- **A peer's concurrent move vs a receiver's durable cascade (sealed).** The durable effect gives way to a later move by a device that had not seen the delete, and the receivers agree while the deleting device is away. RT-78 then deletes the child when that device returns.
- **The authority union.**
  - It is persisted once, and `kora:server:` ids are never stored.
  - A growth re-fold runs in one transaction from the log.
  - A record written between the listing and the re-fold is already folded with the new set.
- **Gates.**
  - `check.mjs --all` ran with Postgres 16, real Chromium and `LMS_OPS=20000`. Result: 162/193 fixed, 0 errors, 0 warnings. No regression and no guard failure, and every new repro fails as owned.
  - `chaos:nightly` passed: 10 clients × 1,000 ops under 10% drop and 5% duplicate, plus the no-silent-loss invariants (11/11).
  - `test:release-gate` passed: production path, sync reconnect, real-path chaos and the benchmark gates.
  - The fold gate on 400 new seeds (seed base 1310001) passed all four tests: every field kind; server-authoritative writes with the server converging; end to end encrypted; and the beta.13 pipeline is still rejected. The fold-vs-legacy check (40 seeds) also passed.

## Not filed (round 3, P3 or below)

- Two devices that both deleted a parent without knowing a late child each author a late cascade copy (two copies per child). Harmless.
- A merge-mode backup import can still carry operations of an explicit authority the importing device has not learned yet. They become authoritative locally once the id is learned. They are local only and never uploaded.

## Not attacked (round 3)

- A real two-instance Postgres race between the duplicate-delete re-check and a new child insert (by code reading only).
- HTTP long-poll transport specifics, and DevTools traces.
- Key rotation across `keyVersion`, and shared key distribution (Phase 4).
- An interrupted `importBackup`, and real Chromium beyond the `check.mjs --all` browser suites.
- Third-party `ServerStore` implementations without `deriveServerOperationId` (unkeyed derivation, documented).

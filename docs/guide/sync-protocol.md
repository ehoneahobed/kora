---
title: Sync Protocol v2
description: "The Kora.js sync protocol v2 (beta.14): content-hash v2 operation ids, the encryption envelope, verification rules, protobuf field numbers and compatibility."
---

# Sync Protocol v2 (beta.14)

Protocol v2 is the single wire bump of decision D2 in the remediation plan. It carries
every wire break of the Phase 3 programme in one compatibility window:

- **Content-hash version 2 (CORE-1).** New operations get ids that also cover
  `previousData`, `sequenceNumber`, `causalDeps` (as a set) and `schemaVersion`.
  `hashVersion` travels with the operation and is verified on receive.
- **Encryption envelope v2 (ENC-3, NEW-ENC-1).** Ciphertext lives in `op.encrypted`,
  bound to the operation by AES-GCM additional data. See
  [Sync Encryption](./sync-encryption.md).
- **Sequence reservation (RT-37).** Protocol-2 clients always send
  `sequenceReservation: true`; `SEQUENCE_CONFLICT` behaves as in Phase 2.
- **Server-authored metadata (W7).** `authoritativeNodeIds` in the handshake response;
  `foldState` on server scope-entry operations.

The constants live in `@korajs/sync`: `SYNC_PROTOCOL_VERSION` (2),
`INVALID_OPERATION_ID`, `PLAINTEXT_REJECTED`, `PROTOCOL_V1_DEPRECATED`.

## Handshake

| Message | Field | Meaning |
|---|---|---|
| `handshake` | `protocolVersion` | `2`. Absent means protocol 1 (Kora <= beta.13). |
| `handshake` | `sequenceReservation` | Always `true` from a protocol-2 client. |
| `handshake-response` | `protocolVersion` | `2`. Absent: a beta.13-era server. |
| `handshake-response` | `authoritativeNodeIds` | The server's node ids (`ServerStore.getAuthoritativeNodeIds()`, `KoraSyncServer.authoritativeNodeIds`): this instance's `kora:server:<deploymentId>:<instanceId>` id, which authors route writes, side effects and constraint corrections, the other `kora:server:` ids with stored operations, and the legacy ids (server node ids from before beta.14, found in the log at the upgrade, and configured extras). Every `kora:server:` node id is authoritative whether listed or not (the prefix rule); the list carries the legacy ids, and serves clients that predate the rule. No device may hand-shake with any of these ids (`INVALID_NODE_ID`, not retriable). Their writes win `merge('server-authoritative')` fields on every replica. The client persists them (`SyncStatePersistence.saveAuthoritativeNodeIds`, one meta key shared with the store's fold) and re-folds affected records when they change. Under end-to-end encryption, a plaintext operation from these nodes touching only cleartext fields is accepted. `kora:scope-entry` is not listed: scope entries carry the server's fold state and are joined, not folded as writes. |
| `handshake-response` | `revokedAuthoritativeNodeIds` | Explicit authoritative ids the deployment revoked (store option `revokedAuthoritativeNodeIds`, RT-81). Absent when there is none. A client removes them from the union of explicit authorities it keeps, persists them as revoked so no later handshake (an instance with a stale configuration) brings them back, and re-folds the records of collections with server-authoritative fields. The server keeps every explicit id it ever held authoritative, revoked ones included, and refuses each at handshake as a device node id (`INVALID_NODE_ID`). |

A protocol-1 client is accepted for beta.14 only: the server logs
`session.protocol_deprecated` (warn) and emits `sync:protocol-deprecated`.

## Operation fields

| Field | Type | Hashed | Notes |
|---|---|---|---|
| `hashVersion` | `1 \| 2` | domain tag of v2 | Absent means 1. Persisted by the client store (op row) and every server store (`operations.hash_version`). Operations whose id is not a content hash (server side effects and constraint corrections, `server/` derived ids; scope entries) never declare it. |
| `foldState` | `string` | no | Server-authored (scope entries). Stripped by the server from every device upload, like `fieldVersions`. |
| `encrypted` | `EncryptedOperationEnvelope` | no | `{ v: 2, alg, keyId, keyVersion, data, previousData, atomicOps? }`; each member `{ iv, ct }`. `data` is then `null` or the cleartext scope fields; `previousData`/`atomicOps` are absent. The id is the v2 hash of the plaintext. Every server store keeps it verbatim (`operations.encrypted`, JSON) and relays it; the server fold folds only the cleartext fields, and an envelope with `data: null` still creates the record (insert) and counts as a write against deletes. |

## Verification

| Where | What | On mismatch |
|---|---|---|
| Server ingest (`ClientSession.handleOperationBatch`) | Plaintext ops declaring `hashVersion: 2`, on the op **as uploaded**, after the authorization, timestamp and size checks and before the operation validator, the reference checks and any schema transform. An unknown declared version fails closed. Envelope ops are not verifiable by the server (it lacks the plaintext). | Non-retriable `operation-rejected` `INVALID_OPERATION_ID`; never stored or relayed. |
| Schema transforms (beta.14, RT-84) | Run at fold time, never on a stored operation: the server stores every op exactly as uploaded (all hashed fields, `hashVersion`, envelope) and judges and folds its view (`operationSchemaView`); devices do the same. Envelope ops are transformed only after decryption, on devices. | n/a |
| Client (`packages/sync/src/engine/verify-inbound.ts`) | After decryption, before transforms and apply: envelope ops always (against their declared version, which the AAD binds); plaintext ops declaring `hashVersion: 2`. Version-1 ops and reserved `kora:` system nodes are not checked. | Quarantined (`_kora_unapplied_ops`, code `INVALID_OPERATION_ID`), `sync:apply-failed`; never released by the quarantine replay. |
| Client decryption (encryption enabled) | Envelope present and authenticates. | `DECRYPT_FAILED` quarantine (`PLAINTEXT_REJECTED`, `LEGACY_ENCRYPTED_PAYLOAD`, `KEY_ID_MISMATCH` in the error context). `allowPlaintextMigration` passes plaintext through. |

Version-1 operations stored before beta.14 keep `hashVersion: 1` (absent) and are never
verified against version-2 rules. Local rewrites before an op is shared (clock rebase,
node rotation, `SEQUENCE_CONFLICT` renumbering, legacy sequence repair) re-hash a
version-2 op with its own version, remapping causal deps first. A renumbered
version-2 op gets a new id: never-sent later operations naming it in `causalDeps` are
rewritten (and re-hashed, transitively) in the same transaction; operations already
sent keep their ids and resolve the old id through `_kora_seq_conflicts.reemitted_as`
(used by `replayTo`). The legacy sequence repair never renumbers a version-2 op when
the other half of the pair is version 1 (that one keeps its id, which the server
deduplicates).

## Protobuf field numbers

Envelope (`SyncEnvelope`, static serializer):

| # | Field | Wire type | Messages |
|---|---|---|---|
| 1-23, 25-45 | unchanged | | see `packages/sync/src/protocol/serializer.ts` |
| 24 | (unused, never reuse) | | |
| 46 | `authoritativeNodeIds` | repeated string | handshake-response |
| 47 | `protocolVersion` | uint32 | handshake, handshake-response |
| 48 | `revokedAuthoritativeNodeIds` | repeated string | handshake-response |

Operation (`SyncOperation`, nested in envelope field 11):

| # | Field | Wire type |
|---|---|---|
| 1-13 | unchanged (`id` ... `hasPreviousData`) | |
| 14 | `hashVersion` | uint32 (absent = 1) |
| 15 | `foldState` | string |
| 16 | `encrypted` | string (envelope JSON) |

Older decoders skip fields 14-16 and 46-47 as unknown fields. `atomicOps`,
`transactionId`, `mutationName` and `fieldVersions` still ride in the data JSON; an
operation without data now carries `atomicOps` there too. The schema-driven
`DynamicProtobufSerializer` (unused) carries the three operation fields in the data JSON
(`__kora_hash_version__`, `__kora_fold_state__`, `__kora_encrypted__`).

## Compatibility matrix

Run with `node scripts/remediation/protocol-v2-compat.mjs <beta13-build>` against a real
33bca46 build, plus the unit and integration suites.

| Client | Server | Result |
|---|---|---|
| v2 | v2 | Full v2: ids verified on both sides, envelope stored opaquely. |
| beta.13 (protocol 1) | v2 | Accepted with a deprecation warning; its version-1 ops are stored and relayed unverified; v2 clients converge with it. Its protocol-1 encrypted payloads are refused by v2 clients with encryption enabled. |
| v2 | beta.13 | Plaintext sync converges (inserts and updates both ways). The old server drops `hashVersion`, so relayed ops are treated as version 1 (not verified by clients). It also drops `op.encrypted`: encrypted sync does not work through a beta.13 server (the receiver quarantines the op as plaintext; nothing is applied wrongly). Upgrade the server first. |

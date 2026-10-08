---
title: Sync Protocol
description: "The Kora.js sync protocol v2: message flow, content-hash v2 ids, the encryption envelope, delivery watermark, heartbeats, verification, the protobuf field table and version compatibility."
---

# Sync Protocol v2

This page is the reference for what travels between a Kora client and the sync server. You do
not need it to build an app; it is for operators, protocol implementers and anyone debugging a
deployment. Kora 1.0.0-beta.13 speaks **protocol 2**. Kora 1.0.0-beta.12 and earlier speak
protocol 1.

Protocol 2 is one wire bump carrying every wire change of the remediation programme:

- **Content-hash version 2.** New operation ids also cover `previousData`, `sequenceNumber`,
  `causalDeps` (as a set) and `schemaVersion`. `hashVersion` travels with each operation and is
  verified on receive.
- **Encryption envelope v2.** Ciphertext lives in `op.encrypted`, bound to the operation by
  AES-GCM additional data, and keys come from a server-stored wrapped keyring. See
  [Sync Encryption](/guide/sync-encryption).
- **Sequence reservation.** A protocol-2 client reserves each operation's sequence number in the
  same local transaction that writes it, so it never puts two operations under one
  `(nodeId, sequenceNumber)`.
- **Server-authored metadata.** `authoritativeNodeIds` and `revokedAuthoritativeNodeIds` in the
  handshake response; `foldState` on scope-entry operations.

The constants live in `@korajs/sync`: `SYNC_PROTOCOL_VERSION` (2), `INVALID_OPERATION_ID`,
`PLAINTEXT_REJECTED` and `PROTOCOL_V1_DEPRECATED`.

## Message flow

```
Client                                      Server
  |--- handshake (vector, watermark, scope) -->|  refused: every other message before it
  |<-- handshake-response (accepted scopes) ---|
  |<-- encryption-key-* (encrypted apps) ----->|  keyring side channel
  |--- operation-batch (own missing ops) ----->|
  |<-- acknowledgment / operation-rejected ----|
  |<-- operation-batch (base..max delivery) ---|  delivery stream, chained
  |--- acknowledgment (deliverySequence) ----->|
  |<-- heartbeat (every 25 s) -----------------|
  |    awareness-update, yjs-doc-update, blob-chunk-* (side channels, scoped)
```

- **The handshake comes first.** The server refuses every other message until an authenticated
  handshake has completed (`HANDSHAKE_REQUIRED`), on WebSocket and HTTP long-poll. A connection
  has `handshakeTimeoutMs` (default 10 s) to send it.
- **Uploads (client to server)** are decided by version vectors: the client sends the operations
  of its own nodes that the server's vector does not cover, in causal order, in batches of
  `batchSize` (default 100; the server refuses batches over `maxOpsPerBatch`, default 1000, with
  `BATCH_TOO_LARGE`).
- **Downloads (server to client)** are a gap-free delivery stream (below).
- Each operation the server refuses is answered with `operation-rejected` (operation id, code,
  message, `retriable`); the rest of the batch is acknowledged. Connection-level problems are
  `error` messages. A `NODE_ID_CLAIMED` error from a beta.14 server also carries
  `nodeOwnership` (`'other-principal'` or `'unowned'`), which protobuf carries in its residual
  field.

## Delivery watermark

Every stored operation has a monotonic **delivery sequence**. Each client persists a **delivery
watermark** per view (scope plus query subsets): the highest delivery sequence up to which it
has applied, or durably quarantined, every in-scope operation with no gap.

- Server batches chain `baseDeliverySequence -> maxDeliverySequence`. The client applies a batch
  only when its watermark equals the base, and advances it only after the batch is fully applied,
  in the same transaction as the applied rows. A dropped or failed batch stalls the watermark and
  is re-sent; nothing is skipped.
- The handshake reports the watermark (`lastDeliverySequence`), and the server resumes just after
  it. A server whose log was rolled back (a restore) reports `serverMaxDeliverySequence` below the
  client's watermark; the client then resets to 0 and resyncs.
- `acceptedScopeKey` and `acceptedScopeWatermark` resume an auth-scoped client's accepted view
  after a reconnect instead of restarting it.
- First sync streams in chunks with backpressure: the server pauses a client's stream above
  `deliveryHighWaterBytes` (1 MiB) and disconnects a consumer that leaves more than
  `maxBufferedBytes` (32 MiB) unsent.
- Live delivery chains from a send cursor; unacknowledged batches are retransmitted on a timer
  (`relayRetransmitIntervalMs`, 2 s).

The design note is `docs/design/durable-delivery.md` in the repository.

## Quarantine

An operation the client cannot apply yet is not dropped. It is stored in `_kora_unapplied_ops`
(and the watermark passes it) when:

| Code | Cause | Applies on a replay once |
|------|-------|---------------|
| `DECRYPT_FAILED` | no key, a wrong key (`KEY_ID_MISMATCH`), a plaintext op under encryption (`PLAINTEXT_REJECTED`), a protocol-1 encrypted payload (`LEGACY_ENCRYPTED_PAYLOAD`) | the keyring unlocks or gains the key (replayed at once) |
| `INVALID_OPERATION_ID` | the id is not the content hash it declares | never (kept for inspection) |
| `SCHEMA_TRANSFORM_UNAVAILABLE` / `SCHEMA_TRANSFORM_INVALID` | no transform path to this client's schema version, or a transform broke its contract | the app upgrades |
| `REMOTE_CLOCK_DRIFT`, `INVALID_TIMESTAMP_FIELDS` | the operation is stamped too far in the future | time catches up |
| `FOLD_STATE_INVALID` | the record's merge state cannot take it even after one re-fold | an upgrade |
| `REFERENTIAL_INTEGRITY` | not appliable in this view (a child whose parent is outside it) | the parent is present |

The quarantine is replayed on every start and whenever the keyring gains keys (and on demand
with the sync engine's `retryQuarantinedOperations()`); each quarantine and release is an event
(`sync:apply-failed`, `sync:apply-recovered`). A failure that may be
transient (a busy database) instead **stalls** delivery (`sync:apply-blocked`, status
`blockedFailure`) and the server re-sends.

## Liveness

- The server pings every WebSocket every `heartbeatIntervalMs` (25 s) and terminates a connection
  that leaves two pings unanswered.
- Browsers cannot see pings, so a client that sets `supportsHeartbeat` also receives an
  application `heartbeat` message every `appHeartbeatIntervalMs` (25 s, announced as
  `heartbeatIntervalMs` in the handshake response). A client that hears nothing for about 2.5
  intervals treats the connection as dead and reconnects.
- A reconnect succeeds only once the new session reaches streaming. The backoff starts at
  `reconnectInterval` (1 s), doubles up to `maxReconnectInterval` (30 s) with 25% jitter, and
  resets only after a connection stayed up for 10 s.

## Handshake fields

| Message | Field | Meaning |
|---|---|---|
| `handshake` | `protocolVersion` | `2`. Absent means protocol 1 (Kora 1.0.0-beta.12 and earlier). |
| `handshake` | `nodeId`, `versionVector`, `schemaVersion` | The device's node, what it holds, its schema version. |
| `handshake` | `authToken` | The credential, unless the transport sends it out of band. |
| `handshake` | `syncScope`, `syncQueries` | What the client asks for; the server's grant can only be narrowed by it. |
| `handshake` | `lastDeliverySequence`, `acceptedScopeKey`, `acceptedScopeWatermark` | Where the delivery stream resumes. |
| `handshake` | `nodeToken` | An anonymous device's secret for its node id. |
| `handshake` | `supportsHeartbeat`, `sequenceReservation` | Capabilities; a protocol-2 client always sends `sequenceReservation: true`. |
| `handshake` | `supportedWireFormats` | Always `['json']`: protobuf is never negotiated (below). |
| `handshake-response` | `accepted`, `rejectReason`, `supportedSchemaMin/Max` | The verdict. |
| `handshake-response` | `acceptedScope`, `acceptedDownlinkScopes`, `acceptedUplinkScopes` | The scopes the server granted. |
| `handshake-response` | `serverTime`, `serverMaxDeliverySequence`, `heartbeatIntervalMs`, `blobStorageEnabled`, `blobPossessionProof`, `nodeToken` | Session facts. |
| `handshake-response` | `authoritativeNodeIds` | The explicit authoritative node ids: legacy server ids (from before beta.13) and configured extras. Every `kora:server:` id is authoritative by its prefix whether listed or not. Clients keep the union of every id they learn and re-fold affected records when it grows. |
| `handshake-response` | `revokedAuthoritativeNodeIds` | Explicit ids the deployment revoked (permanent): clients drop them for good and re-fold. |

No device may hand-shake with a `kora:` node id, the server's node id or any authoritative id,
current, legacy or revoked (`INVALID_NODE_ID`, not retriable). A protocol-1 client is accepted in
1.0.0-beta.13 only: the server logs `session.protocol_deprecated` and emits
`sync:protocol-deprecated`; the next release refuses it.

## Operation fields

| Field | Type | Hashed (v2) | Notes |
|---|---|---|---|
| `id` | string | | SHA-256 content hash of the canonical body. |
| `nodeId`, `type`, `collection`, `recordId` | string | yes | |
| `data`, `previousData` | object or `null` | yes | Canonical JSON (see [Schema Design](/guide/schema-design#how-values-are-normalized)). |
| `timestamp` | `{ wallTime, logical, nodeId }` | yes | HLC. |
| `sequenceNumber` | number | yes | Unique and gap-free per node. |
| `causalDeps` | string[] | yes (as a set) | |
| `schemaVersion` | number | yes | |
| `hashVersion` | `1 \| 2` | domain tag | Absent means 1. Persisted on the client and every server store. Operations whose id is not a content hash (server side effects, constraint corrections, scope entries) never declare it. |
| `atomicOps`, `transactionId`, `mutationName` | | | Ride inside the data JSON. |
| `fieldVersions`, `foldState` | | no | Server-authored (scope entries). The server strips them from every device upload. |
| `encrypted` | envelope | no | `{ v: 2, alg, keyId, keyVersion, data, previousData, atomicOps? }`, each member `{ iv, ct }`. `data` is then `null` or the cleartext fields; the id is the v2 hash of the plaintext. Every server store keeps it verbatim and relays it. |

## Verification

| Where | What | On mismatch |
|---|---|---|
| Server ingest | A plaintext operation declaring `hashVersion: 2` is verified as uploaded, after authorization, timestamp and size checks, before validators and transforms. An operation without `hashVersion` is verified as a version-1 hash. An unknown version fails closed. Encrypted operations cannot be verified by the server (no plaintext). | `INVALID_OPERATION_ID`, not retriable; never stored or relayed. |
| Server ingest, duplicates | An upload reusing a stored id is a duplicate only when every hashed field is equal. | `FORGED_DUPLICATE`, not retriable, no effect; logged, emitted (`sync:forged-duplicate`) and counted. |
| Client, after decryption | Encrypted operations always; plaintext operations declaring version 1 or 2. Reserved `kora:` system nodes are exempt. | Quarantined (`INVALID_OPERATION_ID`), never released. |

Protocol-1 sessions: an operation of a protocol-1 client whose undeclared id cannot be verified
(Kora 1.0.0-beta.12 hashed `undefined` members as `null`, which the JSON upload no longer holds)
is stored unverified for that session's own node, with a warning
(`session.unverified_legacy_operation`, event `sync:unverified-legacy-operation`, metric
`unverifiedLegacyOperations`). A beta.12 `update(id, { field: undefined })` is stored with that
field `null`, as the beta.12 client applied it.

Local rewrites of a version-2 operation before it is shared (clock rebase, node rotation,
`SEQUENCE_CONFLICT` renumbering) re-hash it; never-sent operations naming it in `causalDeps` are
rewritten in the same transaction.

## Wire format

JSON on every transport. `ProtobufMessageSerializer` is lossless for every message type (members
without a native slot ride in field 49, `extJson`), but it is **not negotiated**: clients advertise
`supportedWireFormats: ['json']` and the server reports the format its transport frames with. Use
protobuf only as an explicit choice on both ends of a transport you control. Encryption-key
messages are always JSON. WebSocket messages of 1 KiB or more are compressed with
permessage-deflate unless the server disables it.

### Protobuf field table

Envelope (`SyncEnvelope`):

| # | Field | Type | # | Field | Type |
|---|---|---|---|---|---|
| 1 | `type` | string | 26 | `operationId` | string |
| 2 | `messageId` | string | 27 | `collection` | string |
| 3 | `nodeId` | string | 28 | `recordId` | string |
| 4 | `versionVector` | repeated `{1 key, 2 value}` | 29 | `lastDeliverySequence` | int64 |
| 5 | `schemaVersion` | int32 | 30 | `baseDeliverySequence` | int64 |
| 6 | `authToken` | string | 31 | `maxDeliverySequence` | int64 |
| 7 | `supportedWireFormats` | repeated string | 32 | `deliverySequence` | int64 |
| 8 | `accepted` | bool | 33 | `serverMaxDeliverySequence` | int64 |
| 9 | `rejectReason` | string | 34 | `acceptedScopeJson` | string |
| 10 | `selectedWireFormat` | string | 35 | `acceptedDownlinkScopesJson` | string |
| 11 | `operations` | repeated `SyncOperation` | 36 | `acceptedUplinkScopesJson` | string |
| 12 | `isFinal` | bool | 37 | `retractionsJson` | string |
| 13 | `batchIndex` | uint32 | 38 | `scopeExitPolicy` | string |
| 14 | `acknowledgedMessageId` | string | 39 | `nodeToken` | string |
| 15 | `lastSequenceNumber` | int64 | 40 | `blobPossessionProof` | bool |
| 16 | `errorCode` | string | 41 | `throttled` | bool |
| 17 | `errorMessage` | string | 42 | `retryAfterMs` | int64 |
| 18 | `retriable` | bool | 43 | `acceptedScopeKey` | string |
| 19 | `serverTime` | int64 | 44 | `acceptedScopeWatermark` | int64 |
| 20 | `requestId` | string | 45 | `sequenceReservation` | bool |
| 21 | `hash` | string | 46 | `authoritativeNodeIds` | repeated string |
| 22 | `chunkBytes` | string (base64) | 47 | `protocolVersion` | uint32 |
| 23 | `hasBytes` | bool | 48 | `revokedAuthoritativeNodeIds` | repeated string |
| 24 | unused, never reuse | | 49 | `extJson` | string (`{ set?, unset? }`) |
| 25 | `blobStorageEnabled` | bool | | | |

Operation (`SyncOperation`, envelope field 11):

| # | Field | Type |
|---|---|---|
| 1-5 | `id`, `nodeId`, `type`, `collection`, `recordId` | string |
| 6, 7 | `dataJson`, `previousDataJson` | string |
| 8 | `timestamp` | `{1 wallTime int64, 2 logical uint32, 3 nodeId string}` |
| 9 | `sequenceNumber` | int64 |
| 10 | `causalDeps` | repeated string |
| 11 | `schemaVersion` | int32 |
| 12, 13 | `hasData`, `hasPreviousData` | bool |
| 14 | `hashVersion` | uint32 (absent = 1) |
| 15 | `foldState` | string |
| 16 | `encryptedJson` | string (envelope JSON) |

Older decoders skip unknown fields. The unused `DynamicProtobufSerializer` was removed.

## Compatibility

Upgrade sync servers first, then clients. Verified against the last published release,
1.0.0-beta.12 (tag `v1.0.0-beta.12`), with
`node scripts/remediation/compat-beta12.mjs <beta12-build>` (clients and servers both ways,
databases upgraded in place, mixed fleets under chaos; results in
`remediation/evidence/compat-beta12.md`) and
`node scripts/remediation/protocol-v2-compat.mjs <beta12-build>`, plus the unit and integration
suites.

| Client | Server | Result |
|---|---|---|
| protocol 2 | protocol 2 | Full protocol 2: ids verified on both sides, encrypted operations stored opaquely. |
| protocol 1 (beta.12) | protocol 2 | Accepted for this release with a deprecation warning. Its version-1 ids are verified where beta.12's hash form can be rebuilt (`undefined` members, binary values, a `Date` inside a json value, which beta.12 hashed as `{}`) and the rest are stored and relayed unverified for its own node; protocol-2 clients converge with it. Until it upgrades, the beta.12 client itself keeps beta.12 merge semantics for concurrent edits (its first open of beta.13 re-folds every record). Its encrypted payloads (per-device keys) are refused by protocol-2 clients with encryption on. The beta.13 security rules apply to it too: the server grants scopes, the node must be claimable, and an HTTP long-poll client must be upgraded. |
| protocol 2 | protocol 1 | Plaintext sync converges, but an old server drops `hashVersion` (relayed operations are treated as version 1) and `op.encrypted` (encrypted sync does not work: receivers quarantine). There is no key service (`KEY_SERVICE_UNSUPPORTED`). Do not run this way: upgrade the server first. |

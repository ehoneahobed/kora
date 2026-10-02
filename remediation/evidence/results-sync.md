# Results: SYNC-1..11, ENC-1..3 (+ new defects)

Verifier: independent. Line numbers are current source. All repro tests assert CORRECT behaviour and FAIL today.
Run: `cd <pkg> && npx vitest run tests/repro/<ID>.test.ts`.

Repro tests (all fail today, as intended):
- kora/tests/repro/: SYNC-1, SYNC-2, SYNC-5, SYNC-8, SYNC-10, SYNC-11, ENC-1, ENC-2, NEW-ENC-1, NEW-SYNC-2 (all createApp end to end, `createSyncTransport` mocked to an in-memory KoraSyncServer session or a fake WebSocket under the real WebSocketTransport)
- packages/test/tests/repro/: SYNC-3, SYNC-4, SYNC-7 (TestDevice/TestServer, real SQLite)
- packages/sync/tests/repro/: SYNC-6, SYNC-9, ENC-3, NEW-SYNC-1 (unit)

Summary
| ID | Verdict | Sev | Effort |
|---|---|---|---|
| SYNC-1 | CONFIRMED | P0 | M |
| SYNC-2 | CONFIRMED | P1 | S |
| SYNC-3 | CONFIRMED | P1 | M |
| SYNC-4 | CONFIRMED | P1 | M/L |
| SYNC-5 | CONFIRMED | P2 | S |
| SYNC-6 | CONFIRMED | P3 | S |
| SYNC-7 | PARTIAL (stall confirmed; NaN sub-claim refuted) | P2 | M |
| SYNC-8 | CONFIRMED (stop/reset race: real, harmless) | P2 | S |
| SYNC-9 | PARTIAL (lossy protobuf confirmed; default path is JSON, so unaffected) | P3 | M |
| SYNC-10 | CONFIRMED (3 facets) | P3 (b: P2 on Node) | S |
| SYNC-11 | CONFIRMED, much worse than claimed: a wedge, not just rescans | P1 | S/M |
| ENC-1 | CONFIRMED | P1 | S/M |
| ENC-2 | CONFIRMED | P2 | S |
| ENC-3 | CONFIRMED (integrity gap. Plaintext passthrough is intended, but harmful) | P2 | M |
| NEW-SYNC-1 | CONFIRMED | P1 | S |
| NEW-ENC-1 | CONFIRMED | P1 | S/M |
| NEW-SYNC-2 | CONFIRMED (only latent with the WS/HTTP transports that ship) | P3 | S |

---

## SYNC-1: own edits that leave a reactive-query subset are never uploaded
- Verdict: CONFIRMED.
- Evidence: kora/tests/repro/SYNC-1.test.ts. Device A (createApp, default config) subscribes to `todos.where({completed:false})`, which auto-registers a subset. A then runs `update(id,{completed:true})` and later inserts another todo that is inside the subset.
  - Observed: A reports `status:'synced'` and `pendingOperations:0`, but the server has no update ("A reports synced/0 pending but server lacks the update").
  - With that assertion disabled, the update is still missing after `reconnect()` ("update never reached the server, even after reconnect"), so device B never sees completed=true.
  - Nuance (measured): if NO later local op is acked first, the next reconnect recovers the op through `reconcileOutboundFromOpLog` (sync-engine.ts:1865-1871 enqueues unfiltered). The loss becomes permanent once any later in-subset local op is acked.
- Location:
  - sync-engine.ts:529-532 (pushOperation drops the op).
  - :2064-2092 (`matchesScopeAndSubsets` applies `operationMatchesQuerySubsets` to UPLOADS, :2090).
  - :1274 (sendDelta filters the handshake delta the same way).
  - :1609 and :1828-1837 (`advanceLastAckedForLocalNode` = max(lastAcked, ackSeq) jumps over the never-sent op).
  - :1791-1797 (checkDeltaComplete marks everything up to localSeq acked).
  - Subsets are auto-registered at kora/src/initialize-app.ts:94 and sync-query-bridge.ts:52. The default mode is 'reactive' (sync-engine.ts:937, 986).
- Intent: downlink-only.
  - Docs (guide/sync-configuration.md:230): "The server filters delta exchange and relay to match".
  - Server: client-session.ts:1338 "Upload authorization is independent from the client's downloaded/query view". `operationAllowedFromClient` ignores subsets.
  - sync-engine.test.ts:2038-2065 ("pushOperation skips ops outside registered query subsets") encodes the bug and must be inverted.
- Root cause: one predicate (`matchesScopeAndSubsets`) is used for both directions. Separately, the upstream ack position is a max, not a contiguous prefix.
- Fix:
  1. Split the predicate. `operationAllowedForUpload(op)` = `operationMatchesScope(op, activeUplinkScope, backfill)` only. `operationAllowedForDownload(op)` = downlink scope (+ subsets), or no client inbound filter for delivery batches because the server is authoritative. Use the upload predicate in pushOperation, sendDelta and reconcile.
  2. Track a contiguous acknowledged prefix (shared with SYNC-3/4):
     - Keep `localAckedThrough`, the highest seq s such that every local op with seq ≤ s is server-acked or terminally resolved. Terminally resolved means a non-retriable rejection recorded in rejectedStorage, or a permanent out-of-uplink-scope quarantine with an event.
     - Acks advance it only for ops of the batch named by `acknowledgedMessageId`, and only through the first un-acked seq.
     - Persist `localAckedThrough` instead of max-merging. `reconcileOutboundFromOpLog` enqueues every local op above it.
  - Invariant: an op is never counted as synced unless the server has stored it, or it was terminally rejected and recorded.
- Regression risk: medium. Upload volume rises for subset users (correctly). Pending counts change. Existing test 2038 must flip.
- Severity: P0 (default config, silent loss, status lies). Effort: M.

## SYNC-2: inbound ops filtered by uplink scope
- Verdict: CONFIRMED.
- Evidence: kora/tests/repro/SYNC-2.test.ts.
  - Setup: KoraSyncServer auth returns reader `{downlinkScopes:{todos:{},announcements:{}}, uplinkScopes:{todos:{}}}`. Admin inserts an announcement.
  - On the reader, `deliveryWatermark === serverFrontier (1)` but `findById` returns null ("announcement dropped on ingest").
  - Still null after reconnect. During that reconnect the engine also wedged in 'syncing' (see SYNC-11 / NEW-SYNC-1).
- Location: sync-engine.ts:1409 (`filterAllowedForSync` on inbound) → :2085 (`activeUplinkScope`). Dropped ops never clear `fullyApplied`, so :1517 advances the watermark.
- Root cause: the same direction-agnostic predicate as SYNC-1.
- Fix: inbound delivery batches must not be filtered by the uplink scope. Either apply all server-delivered ops (the server already applies the downlink scope), or filter by `activeScope`. Any op the client deliberately does not apply must clear `fullyApplied` or be quarantined.
- Regression risk: low.
- Severity: P1 (needs directional scopes; silent permanent loss). Effort: S.

## SYNC-3: non-success apply results advance the watermark
- Verdict: CONFIRMED.
- Evidence: packages/test/tests/repro/SYNC-3.test.ts.
  - A v1 device (server supports v1..v2) receives a v2 `notes` insert. It emits `sync:apply-failed notes:APPLY_SKIPPED` (retriable:false) and the watermark advances.
  - The same DB is then reopened with the v2 schema and synced. Control: a NEW note arrives. The original note is never re-delivered ("expected [ Array(1) ] to include <noteId>").
- Location:
  - sync-engine.ts:1438-1441 ('skipped' | 'rejected' | 'deferred' only emits).
  - :1431-1435 (transform → null is a silent `continue` with no event).
  - :1517 advances.
  - Sources: store.ts:280-283 (unknown collection → 'skipped'); apply-pipeline.ts:262-264 (restrict → 'rejected'); apply-pipeline.ts:246-249 ('skipped' when a local update beats a remote delete: an intentional merge outcome, fine to advance).
- Root cause: `fullyApplied` is only cleared on throw. The design doc says the watermark advances "only when every operation in a batch is durably applied".
- Fix:
  - Classify the result. 'applied', 'duplicate' and merge-decided 'skipped' advance.
  - 'skipped' (unknown collection or schema), transform-null and 'deferred' must not be lost. Persist the raw op to a durable inbound quarantine (`_kora_unapplied_ops`, keyed by op id + delivery seq) and then advance. Replay the quarantine on schema upgrade (store migration hook) and on start.
  - Restrict-'rejected' deletes: persist the op in the op log, and make the server apply the same restrict rule so both sides converge deterministically.
  - Invariant: watermark ≤ min delivery seq of any op that is neither applied nor durably quarantined.
- Regression risk: medium (new table, replay ordering).
- Severity: P1. Effort: M.

## SYNC-4: handshake-delta ops counted as acked before the server acks; acks not matched to batches
- Verdict: CONFIRMED.
- Evidence: packages/test/tests/repro/SYNC-4.test.ts.
  - An offline insert is sent in the handshake delta. The validator rejects it once with `retriable:true`, then accepts.
  - A later streaming insert is accepted.
  - After two reconnects the server still lacks the op ("retriably-rejected handshake-delta op never retried").
- Location:
  - sync-engine.ts:1336-1339 (non-strict: `deltaSendComplete` immediately).
  - :1786-1789 (`removeByIds(deltaSentOpIds)` before any ack).
  - :1791-1797 (lastAcked := localSeq).
  - :1702-1716 (a retriable reject with `currentBatch===null` is a no-op).
  - :1584-1609 (`acknowledgedMessageId` ignored; any ack acks the current streaming batch; ack seq max-merged).
  - Server max-vector: memory-server-store.ts:91-93.
- Root cause: no correlation between acks and batches, and a non-contiguous ack position.
- Fix:
  - Always use strict-handshake bookkeeping. Track every sent batch (delta and streaming) in a `Map<messageId, Operation[]>`. On an ack, resolve only that batch: ops with seq ≤ ack.lastSequenceNumber are acked, the rest return to the queue.
  - Route retriable `operation-rejected` to the batch containing that op id.
  - Advance `localAckedThrough` contiguously (see SYNC-1).
  - Server side: accept a client op only if `seq == serverVector[node]+1` (otherwise reject retriable `OUT_OF_ORDER`), so the server's per-origin vector is itself a contiguous prefix and delta-by-vector can never skip a gap.
- Regression risk: medium-high (handshake completion timing, perf of strict acks).
- Severity: P1. Effort: M/L.

## SYNC-5: engine goes 'disconnected' without closing the transport; WebSocketTransport overwrites `ws`
- Verdict: CONFIRMED.
- Evidence: kora/tests/repro/SYNC-5.test.ts. The setup is the real WebSocketTransport with a fake WebSocketImpl bridged to KoraSyncServer.
  - One undecodable frame produces an error. Auto-reconnect opens socket #2, but socket #1 is still open ("expected 1 to be 3"). The server reports `getConnectionCount() === 2`.
  - When stale socket #1 later closes, its onclose sets `this.ws=null` and calls the engine close handler. Measured: the live session went `offline`, and a 3rd socket was opened. Socket #2 is now orphaned and also never closed.
- Location:
  - sync-engine.ts:2038-2045 (handleTransportError) and :1078-1082 → :2017-2036 (no `transport.disconnect()`).
  - :491-494 (stopInternal returns early when already 'disconnected', so `reconnect()` cannot clean up either).
  - websocket-transport.ts:120-121 (`this.ws = ws` without closing the old one) and :143-146 (old socket's onclose nulls the new `ws` and fires the shared handler).
- Fix:
  - On any engine-initiated transition to disconnected, call `transport.disconnect()`.
  - In WebSocketTransport.connect, close and detach handlers of any existing ws.
  - Bind each ws's handlers to a generation id so callbacks from a superseded socket are ignored (`if (ws !== this.ws) return`).
- Regression risk: low.
- Severity: P2. Effort: S.

## SYNC-6: OutboundQueue `seen` grows forever
- Verdict: CONFIRMED.
- Evidence: packages/sync/tests/repro/SYNC-6.test.ts. After 1000 enqueue/take/acknowledge cycles, `seen.size === 1000`, and re-enqueue of an acked op is ignored.
- Location: outbound-queue.ts:86-93 (`acknowledge` omits `seen.delete`). acknowledgeThrough/reject/removeByIds (:118-120, :251, :277-279) do delete.
- Fix: delete acked ids from `seen` in `acknowledge()`.
- Regression risk: very low. Duplicate protection is still provided by content-addressed server dedup.
- Severity: P3 (memory leak for long sessions; re-queue blocking only matters combined with SYNC-4). Effort: S.

## SYNC-7: far-future remote op stalls the stream
- Verdict: PARTIAL.
- Evidence: packages/test/tests/repro/SYNC-7.test.ts.
  - An op stamped +24h is placed in the server store (as written under a wrong server clock or restored).
  - The receiver emits `REMOTE_CLOCK_DRIFT:true` (retriable) and never acks. `deliveryWatermark` is stuck at 1 while the frontier is 6 ("expected 1 to be 6"); this persists across reconnects.
  - Later ops in the same re-scanned batch DID apply. Ops more than one batch (batchSize, default 100) past the poison op are blocked by the base/gap chain (sync-engine.ts:1373-1389).
- Location: sync-engine.ts:1466-1476 (`retriable = code !== REFERENTIAL_INTEGRITY`, so REMOTE_CLOCK_DRIFT is retriable and blocking); hlc.ts:146-150.
- Intent: the stall-not-skip behaviour is deliberate (durable-delivery.md: "becomes a visible stall"). The harm is head-of-line blocking of every later op for the drift duration, plus the server retransmitting forever.
- NaN sub-claim REFUTED for KoraSyncServer. It always sends `serverTime` (client-session.ts:864, 880), so `clockSkewMs` is set before any INVALID_TIMESTAMP error and the NaN fallback at sync-engine.ts:1651 is unreachable unless a third-party server omits serverTime. In that case it is self-healing at the next handshake.
- Fix:
  - Clamp rather than reject. Store and apply the op but do not adopt its wallTime into the local HLC (receive validation separate from apply).
  - Or quarantine it (as in SYNC-3) with a durable record, and advance.
  - Server: re-validate timestamps at ingest from every path, including route `kora.apply` and backup import.
- Regression risk: low/medium.
- Severity: P2 (needs a clock anomaly). Effort: M.

## SYNC-8: reconnect backoff never grows
- Verdict: CONFIRMED.
- Evidence: kora/tests/repro/SYNC-8.test.ts. The server accepts each connection and drops it 5ms after the handshake. With `reconnectInterval:40`, there were 42 connects in 2s at a steady ~45ms ("expected 42 to be ≤ 8"). ENC-2's test independently shows a 1s loop with defaults.
- Location:
  - sync-engine.ts:470 (`start()` resolves once the handshake is sent).
  - kora/src/sync-lifecycle.ts:179-188 (counts that as success).
  - reconnection-manager.ts:57-60 (`attempt = 0` on every start) and :74-78 (reset).
- stop/reset race: sync-control.ts:258-259 and :277-278. `stop()` resolves the pending wait, then `reset()` clears `stopped` before the loop resumes, so the loop calls `syncEngine.start()` concurrently. It is coalesced by `startPromise` / `stopPromise`, so this is real but harmless.
- Fix:
  - Define success as reaching 'streaming' (resolve from `checkDeltaComplete`), not as the handshake being sent.
  - Keep the attempt counter across manager runs. Reset it only after a session stays streaming for N seconds.
  - Fix the race: make `reset()` not clear `stopped`, or give each start() a token.
- Regression risk: low.
- Severity: P2 (thundering herd against a failing server). Effort: S.

## SYNC-9: protobuf negotiation dead/unsafe
- Verdict: PARTIAL.
- Evidence: packages/sync/tests/repro/SYNC-9.test.ts. A ProtobufMessageSerializer round trip drops `syncQueries` and `deltaCursor` (handshake) and `supportedSchemaMin/Max` (handshake-response). `lastDeliverySequence` survives.
- Negotiation is dead in the default path:
  - The client WebSocketTransport always frames with its own JsonMessageSerializer (create-sync-transport.ts:8-13 passes none). The engine's NegotiatedMessageSerializer only encodes per-op payloads, always as JSON (serializer.ts encodeOperation).
  - The server picks 'protobuf' whenever it is offered (client-session.ts:1440-1445) and advertises it, but the default server serializer is JSON with no `setWireFormat`.
  - Default config is therefore unaffected.
- Unsafe on opt-in: the server passes ONE `this.serializer` to every session (kora-sync-server.ts:150, 662) and to every HttpServerTransport (:895). With a NegotiatedMessageSerializer configured, one session's `setWireFormat` (client-session.ts:842, 1426) flips framing for all HTTP sessions.
- DynamicProtobufSerializer has no delivery fields, but it is unexported and unused (dead code).
- Fix:
  - Per-session serializer instances.
  - Make the transport and session share the negotiated per-connection serializer.
  - Add the missing fields to the .proto and both serializers, plus a property test that round-trips every message type.
  - Or stop advertising protobuf until this is done.
- Regression risk: low.
- Severity: P3. Effort: M.

## SYNC-10: timers and async sends outlive stop/close
- Verdict: CONFIRMED.
- Evidence: kora/tests/repro/SYNC-10.test.ts.
  - (a) After an unrequested server close followed by `app.close()`: the awareness `cleanupTimer` is still set, and the `querySubsetReconnectTimer` is still set (each checked separately).
  - (b) With encryption, `engine.stop()` while a batch is encrypting leads to an `unhandledRejection` "Cannot send message: client transport is not connected".
- Location:
  - sync-engine.ts:491-497 (stopInternal returns before `stopCleanupTimer` when already disconnected; the subset timer is never cleared anywhere).
  - :2132-2143.
  - :1900-1920 (the `.then` sends without checking state or batch identity, and has no catch for a throwing `send`).
- Fix:
  - In stopInternal, clear all timers before the early return.
  - Add `destroy()` for app.close.
  - In the encrypt `.then`, check `this.currentBatch?.batchId === batch.batchId && this.state === 'streaming'` before sending, and wrap the send in try/catch that returns the batch.
- Regression risk: very low.
- Severity: P3 (P2 on Node: an unhandled rejection terminates the process by default). Effort: S.

## SYNC-11: accepted scope alters the view key; wedges sync on reconnect
- Verdict: CONFIRMED. Far worse than "extra rescans".
- Evidence: kora/tests/repro/SYNC-11.test.ts.
  - Setup: an ordinary auth-scoped server (`scopes:{todos:{},announcements:{}}`); the client has no `sync.scope`.
  - After the first `reconnect()`, `phase === 'receiving'` (state 'syncing') forever, and a write after the reconnect never uploads ("condition never held: write after reconnect uploaded").
  - The wedge persists across restarts because the watermark is persisted.
- Mechanism:
  - sync-engine.ts:1181-1183 replaces `activeScope` with the server's accepted scope, so `deliverySignature()` changes without `switchDeliveryView`.
  - The next handshake still sends `syncScope: this.config.scopeMap` (:459).
  - The server sees `!sameScopeMap(msg.syncScope, downlinkScopes)` and resets the client watermark to 0 (client-session.ts:817-822).
  - The full resync arrives with base 0 below the client watermark. The duplicate branch (sync-engine.ts:1391-1397) acks and returns without the `state === 'syncing'` bookkeeping, so the final batch never completes initial sync (NEW-SYNC-1).
- Fix:
  - (i) Handshake sends the last accepted downlink scope (persisted), or the server compares the canonicalised resolved scope against the scope it resolved last time for this node.
  - (ii) When the accepted scope differs, call `switchDeliveryView(previousSignature)`.
  - (iii) Fix NEW-SYNC-1.
- Regression risk: low-medium.
- Severity: P1 (any auth-scoped deployment: sync stops after the first reconnect; local data is kept). Effort: S/M.

## ENC-1: random salt per process
- Verdict: CONFIRMED.
- Evidence: kora/tests/repro/ENC-1.test.ts. The server is schema-less, to isolate this from NEW-ENC-1. Two createApp instances use the same passphrase.
  - Control: the server stores ciphertext only.
  - Device B emits `sync:disconnected` "Failed to decrypt operation data field…" and never has the row ("expected undefined to be 'secret'").
  - The same applies to one device after a reload (a new salt per process).
- Location: kora/src/initialize-app.ts:171-174 (`SyncEncryptor.create(config)` with no salt); sync-encryptor.ts:91-112; key-derivation.ts (random 32-byte salt when omitted). SyncEncryptionConfig has no salt field (types.ts:36-50).
- Intent: docs/guide/sync-encryption.md:83 claims "Kora handles this automatically … the salt is stored alongside the key version", and :222 says other devices with the same passphrase can decrypt. Both are false.
- Fix:
  - Make the salt deterministic and shared. Either add `salt` to the config (required, or derived as `SHA-256("kora-e2e:" + appId/schema name + userId)`), or persist the generated salt in an encrypted-key envelope the server stores and serves.
  - Persist the salt locally (`_kora_meta`).
  - Include `kdfSalt` / key id in EncryptedPayload so a mismatch is diagnosable.
- Regression risk: data encrypted with today's random salts is unrecoverable anyway.
- Severity: P1 (opt-in feature non-functional). Effort: S/M.

## ENC-2: decrypt failure treated as a connection failure
- Verdict: CONFIRMED.
- Evidence: kora/tests/repro/ENC-2.test.ts. One op from a different key causes 3× `sync:disconnected` "Failed to decrypt…" in 2.5s, with zero `sync:apply-failed`. It loops forever, and each loop also leaks the transport (SYNC-5).
- Location: sync-engine.ts:1405-1407 (`decryptBatch` outside the per-op try); :1041-1045 and :1078-1082 (any handler throw becomes a fake close).
- Fix: decrypt per op inside the apply try. A DecryptionError is then a non-retriable blocking apply failure for that op: quarantine it (as in SYNC-3), emit `sync:apply-failed`, and keep the session. Also make handleMessageFailure close the transport (SYNC-5).
- Regression risk: low.
- Severity: P2. Effort: S.

## ENC-3: no AAD; plaintext accepted
- Verdict: CONFIRMED.
- Evidence: packages/sync/tests/repro/ENC-3.test.ts. `decryptOperation` returns a forged plaintext op unchanged, and a ciphertext transplanted from op-a/acct-a to op-b/acct-b decrypts successfully.
- Location: sync-encryptor.ts:331-335 (no `additionalData`) and :373-376 (plaintext passthrough). Every inbound op passes through this (sync-engine.ts:1405).
- Intent: the passthrough is documented as "mixed mode". It is harmful under the E2E threat model, since the server can forge or swap record contents undetected.
- Fix:
  - AES-GCM `additionalData` = canonical(nodeId, collection, recordId, type, timestamp, sequenceNumber, fieldName, key version). Do not use op.id: it is a hash of the plaintext. Instead, verify op.id over the decrypted plaintext (CORE-1).
  - When encryption is enabled, reject non-envelope `data`/`previousData` unless an explicit `allowPlaintextMigration` window is configured.
  - Version the envelope (`v2` with AAD).
- Regression risk: wire-format break, so a migration flag is needed.
- Severity: P2 (needs a malicious server). Effort: M.

## NEW-SYNC-1: duplicate-branch final batch never completes initial sync
- Verdict: CONFIRMED.
- Evidence: packages/sync/tests/repro/NEW-SYNC-1.test.ts. A client with watermark 5 gets a server full-resync batch (base 0, max 5, isFinal). The state stays 'syncing' ("expected 'syncing' to be 'streaming'"). Control with watermark 0 passes.
- Location: sync-engine.ts:1391-1397 (returns before :1534-1569).
- Fix:
  - In the duplicate branch, still run the syncing bookkeeping (count the batch; if `isFinal`, set `deltaReceiveComplete` and call `checkDeltaComplete`).
  - Better: when `base < watermark < max`, apply the batch's ops (idempotent via dedup) and advance to max, rather than discarding a batch that straddles the watermark. Otherwise the next chained batch with base == max > watermark is a gap.
- Severity: P1 (root of the SYNC-11 wedge). Effort: S.

## NEW-ENC-1: schema-aware server rejects every encrypted op
- Verdict: CONFIRMED.
- Evidence: kora/tests/repro/NEW-ENC-1.test.ts. TestServer (with `store.setSchema(schema)`, as every CLI template's server.ts does) puts an encrypted insert into `getRejectedOperations()`: `SCHEMA_VALIDATION_ERROR` 'contains undeclared field "__kora_e2e_encrypted"', non-retriable. Nothing syncs.
- Location: packages/server/src/apply/apply-server-operation.ts:128-137 (`validateOperationShape`). The templates call setSchema (packages/cli/templates/*-sync/server.ts).
- Fix:
  - Recognise the encrypted envelope in `validateOperationShape` and skip field-level validation and materialization of encrypted payloads, storing them opaque.
  - Or move the ciphertext out of `data`, e.g. `op.encrypted = {...}` with `data:null`, plus scope fields in cleartext as documented.
- Severity: P1. Effort: S/M.

## NEW-SYNC-2: reconnect loop loses a disconnect that races start()
- Verdict: CONFIRMED with an in-process transport. It is latent with the WS/HTTP transports that ship: their close events arrive in a later task, after the manager has exited.
- Evidence: kora/tests/repro/NEW-SYNC-2.test.ts. The server drops the first 3 sessions synchronously on handshake. Only 2 attempts are made, and the app then stays offline forever ("attempts: 2").
- Location: kora/src/sync-lifecycle.ts:173-175 (`isRunning()` guard drops the event) together with reconnection-manager.ts:74-78.
- Fix: in the disconnected handler, if the manager is running, set a `pendingRetry` flag that the manager checks after `onReconnect` returns. Alternatively, resolve success only on 'streaming' (as in SYNC-8).
- Severity: P3. Effort: S.

## Not a finding, but observed (not investigated)
- `app.sync.waitForSettled({timeoutMs:5000})` failed twice with in-memory sessions:
  - It took about 5s to resolve 'settled' when the app was already settled. It appears to wake only on the 5s `connection:quality` tick.
  - In one run, on a second app, it never resolved even after 15s, despite the timeout.
- These are outside my items, so I did not verify them further.

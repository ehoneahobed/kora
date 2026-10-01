# Findings register (claims to verify)

Each claim came from a first-pass review. Treat every claim as UNPROVEN. Your job is to confirm or refute it.

## SEC: server and sync authorization (packages/server, packages/sync)
- SEC-1 Server processes `operation-batch` before handshake; no state gate (client-session.ts ~638-645); upload scope undefined => operationMatchesScopes returns true (server-scope-filter.ts ~69). Unauthenticated writes.
- SEC-2 Upload scope check trusts client-supplied previousData (buildSnapshot in server-scope-filter.ts; missingScopeFields skips stored-row lookup when previousData has scope field). Cross-tenant edit/delete. Variant: update data:{userId:'mallory'} takes ownership because only data is checked, not the stored row.
- SEC-3 No binding of op.nodeId to session/device; op.id hash never verified (verifyOperationIntegrity unused on receive). Forged high sequenceNumber for victim nodeId raises server version vector so victim's later uploads are skipped (sync-engine.ts ~1352 collectDelta). Streaming skips ops whose nodeId equals receiver (client-session.ts ~1228).
- SEC-4 Handshake response leaks the full server version vector (all node ids across tenants) (client-session.ts ~876).
- SEC-5 Yjs doc relay, awareness/presence relay, blob relay registered before handshake with no auth or scope check (kora-sync-server.ts ~704-705). Blob pending map unbounded; blob-chunk-push persists before auth with no size limit.
- SEC-6 Route-context scope check (route-context.ts ~250, ~344) checks op alone: setting scope field to caller's value takes over a record; query applies limit before scope filter.
- SEC-7 SQL injection via orderBy direction, limit, offset (store sql-builder.ts ~41-50).
- SEC-8 Auth token sent as URL query parameter (websocket-transport.ts ~116).
- SEC-9 Old-timestamp ops accepted (wallTime:1) so ops can be backdated to always lose LWW; getClientIp trusts X-Forwarded-For; sqlDefaultLiteral does not escape quotes.

## AUTH (packages/auth)
- AUTH-1 Built-in toSyncAuthProvider returns no scopes, so client handshakeScope used as-is (auth-routes.ts ~950); mergeScopeMaps lets handshake add collections the server never mentioned (resolve-session-scopes.ts ~60-64); MixedAuthProvider same.
- AUTH-2 Revoked device recovers: refreshAccessToken checks isRevoked(jti) not isDeviceRevoked (token-manager.ts ~460); HTTP routes use validateToken which skips revocation.
- AUTH-3 OAuth state not bound to browser/user/purpose (oauth-flow.ts ~184); link-CSRF account takeover; login CSRF.
- AUTH-4 listMyInvitations(email) returns tokens for any email; acceptInvitation does not check email match (org-routes.ts ~573); revokeInvitation does not check org ownership (~609).
- AUTH-5 Client-chosen deviceId; registerDevice returns device owned by another user; attacker can trigger reuse detection to revoke victim's device. Default deviceId `device-${userId}` shared by all browsers of a user (auth-routes.ts ~393, ~483).
- AUTH-6 Concurrent refreshes with same token both succeed (check then revoke, not atomic).
- AUTH-7 Password reset token returned in HTTP response when no onResetRequested callback (password-reset.ts ~256); reset/change password doesn't revoke tokens.
- AUTH-8 Sign-out does not stop access token on HTTP routes (/auth/me still 200).
- AUTH-9 Account enumeration via sign-in timing (no dummy hash) and sign-up 409; rate limit key email+IP.
- AUTH-10 MFA not enforced at token issuance; TOTP verify has no attempt limit; disable() doesn't consume code.
- AUTH-11 Live sync sessions never re-checked after revocation/role change.
- AUTH-12 InMemoryTokenRevocationStore default in createKoraAuthServer (quickstart-server.ts ~154): revocations lost on restart, not shared across instances.
- AUTH-13 Client initialize() signs user out when access token expired and refresh fails due to no network (auth-client.ts ~417-424) -> offline users logged out.
- AUTH-14 Lows: passkey UV flag unchecked; webhook SSRF/no replay window; AdminApi trusts adminId; ExternalJwtProvider HS256 missing exp => never expires, no iss/aud.

## SYNC (client engine, packages/sync + kora/src)
- SYNC-1 Outbound ops filtered by active query subsets (matchesScopeAndSubsets used in pushOperation ~530 and sendDelta ~1274, ~2081). Subsets auto-registered per reactive query (kora/src/initialize-app.ts ~94). Own edits leaving a subset never uploaded, then treated as acked (checkDeltaComplete ~1795). Existing test sync-engine.test.ts ~2046 asserts this.
- SYNC-2 Inbound ops filtered by uplink scope instead of downlink scope (handleOperationBatch -> filterAllowedForSync -> activeUplinkScope ~1409, ~2085); with directional scopes, read-only collections dropped while watermark advances.
- SYNC-3 Non-success apply results (skipped, rejected, deferred) still advance the delivery watermark (~1439, ~1523): schema-mismatch ops, null schema transform (~1433), restrict-rejected deletes lost permanently.
- SYNC-4 Acks not matched to batch (handleAcknowledgment ~1584 ignores acknowledgedMessageId); handshake-delta ops removed from queue before ack in non-strict mode (~1786) and lastAckedVector advanced (~1791). With retriable rejection + max-vector upstream => permanent loss.
- SYNC-5 Engine/transport desync: handleTransportError (~2038) and handleMessageFailure (~1078) set state disconnected without closing transport; reconnect overwrites this.ws without closing old socket (websocket-transport.ts ~120); two sessions feed one handler.
- SYNC-6 OutboundQueue `seen` set grows forever; acknowledge() doesn't remove ids; acked op can't be re-queued.
- SYNC-7 One remote op >5 min in future throws RemoteClockDriftError classed retriable (~1475): batch never acked, stream blocked forever, no quarantine. Also skewMs NaN passed to setClockReferenceOffset (~1651, sync-lifecycle.ts ~62) disables validation.
- SYNC-8 Reconnect backoff never grows: start() resolves after handshake sent, reconnect manager resets (sync-lifecycle.ts ~125). Suspected race in sync-control.ts ~41 stop(); reset().
- SYNC-9 Protobuf negotiation dead/unsafe: transport uses its own JSON serializer; server shares one serializer across sessions (kora-sync-server.ts ~150); protobuf drops syncQueries/deltaCursor/supportedSchemaMin; DynamicProtobufSerializer lacks delivery fields.
- SYNC-10 Timers not cleared: querySubsetReconnectTimer on stop(); awareness cleanup timer on unrequested close; encrypted send can complete after stop().
- SYNC-11 Accepted-scope change from server alters view key without switching watermarks (~1182): extra rescans.

## ENC: end-to-end encryption
- ENC-1 kora/src/initialize-app.ts ~173 calls SyncEncryptor.create(config) without salt -> random salt per process -> different key per device/reload; cannot decrypt.
- ENC-2 decryptBatch outside try (~1405): decrypt failure treated as close, server resends forever.
- ENC-3 No AAD binding ciphertext to op id/record/field; decryptField accepts plaintext (mixed mode) so a server can inject unauthenticated plaintext.

## SRV: server correctness, scale, operations
- SRV-1 Server materialization (replayOperationsForRecord: HLC LWW + atomics) differs from client merge (add-wins arrays, object merge, custom resolvers, constraints). Insert resets record; any later update revives a deleted record server side.
- SRV-2 Visibility judged against record's CURRENT state (operationVisibleToClient client-session.ts ~1319): record moving into scope/subset delivers updates without its insert; moving out never retracted; auth-scope narrowing sends no retractions; retractions rely on client previousData.
- SRV-3 pushDeliveryStream re-reads from lastAckedDeliverySeq (0 right after handshake) so unacked backlog is re-sent on every relay (~401, ~438); measured ~4x data.
- SRV-4 Postgres version vector is a per-instance in-memory cache (postgres-server-store.ts ~41, 68, 178); old-protocol clients on instance B never see A's writes; dedup check outside transaction; sequence_number INTEGER overflows above 2^31.
- SRV-5 sendDeliveryStream loads all deliverable ops into memory (~1212); memory store getOperationsAfterDelivery scans whole log per chunk (O(N^2)).
- SRV-6 HTTP sessions never expire (kora-sync-server.ts ~508); clientId acts as bearer token; no handshake timeout, heartbeat, backpressure; maxConnections unlimited; readBodyBuffer unlimited (production-server.ts ~280); no ops-per-batch limit; per-session rate limiter reset on reconnect; scope-rejected ops not counted.
- SRV-7 No op-log compaction; tombstones forever; each write replays full record history.

## STORE (packages/store)
- STORE-1 store.transaction() reuses sequence numbers (transaction-sequence.ts ~18 reads watermark once outside tx; INSERT OR REPLACE can move vector backwards); no UNIQUE(node_id, sequence_number) on op tables (sql-gen.ts ~95).
- STORE-2 Cascade deletes inside store.transaction() collide on sequence numbers (relation-enforcer.ts ~187).
- STORE-3 Transactional insert/update don't stamp _field_versions; transactional delete doesn't write _version: stale remote wins locally, server keeps local -> permanent divergence; resurrection by stale insert.
- STORE-4 Secret fields written via store.transaction() stored and synced as plaintext (no transformSecretFieldsForWrite).
- STORE-5 Backup restore: timestamps written with JSON.stringify not canonical serializer; atomicOps/transactionId/mutationName dropped; merge mode overwrites _kora_meta node_id, watermarks, acked server vector, version vector (can move backwards); replace mode doesn't reload in-memory node id/vector/clock or invalidate subscriptions (backup.ts ~376-415).
- STORE-6 IndexedDB adapter: follower tab runs restoreFromDumpFallback against leader's live DB via bridge (indexeddb-adapter.ts ~96-110).
- STORE-7 IndexedDB flushNow re-entrancy loses writes (indexeddb-persistence-scheduler.ts ~63-71); 500ms loss window; full-dump per flush; torn snapshots.
- STORE-8 execute/query bypass adapter mutex and run inside another caller's open BEGIN (phantom reads; non-tx writes lost on rollback).
- STORE-9 Concurrent atomic increments lose update locally (execute-update.ts ~32 reads row outside tx).
- STORE-10 Multi-tab: remote op already applied by other tab returns 'duplicate' without notifying subscriptions (store.ts ~307); each tab has own SyncEngine; shared node id with per-tab in-memory vectors.
- STORE-11 validateFieldName accepts createdAt/updatedAt but no such columns, so documented .orderBy('createdAt') throws.
- STORE-12 Subscription diff uses !== so array/object/Uint8Array fields always re-notify; re-run errors swallowed (~236); registerAndFetch no .catch.
- STORE-13 Migrations: DDL statements outside a transaction, schema_version written last; backfills don't create ops or update field versions so never sync.
- STORE-14 Compaction never invoked automatically; if invoked, breaks whole-log re-fold and duplicate detection; no index on (node_id, sequence_number).
- STORE-15 Lows: in-memory vector updated before COMMIT; duplicate check before tx; index name collisions; SQLITE_FULL not mapped to quota event.
- STORE-16 Benchmarks: "SQLite WASM" gate uses MockWorkerBridge (better-sqlite3 in-process); per-collection invalidation re-runs all subscriptions.

## MERGE / CORE
- MERGE-1 addWinsSet loses one-sided removals when the other side concurrently changes the array: addWinsSet([], ['urgent','billing'], ['urgent']) -> ['urgent','billing'] (merge/src/strategies/add-wins-set.ts).
- MERGE-2 Pairwise three-way merge in kora/src/apply-pipeline.ts uses remote op previousData as base vs current local row; for non-scalar kinds results may depend on delivery order across 3+ replicas (convergence not guaranteed). Verify with a 3-replica random-order test for arrays, objects, custom resolvers.
- CORE-1 causalDeps always [] for user ops; content hash excludes previousData/sequenceNumber/causalDeps/schemaVersion; ids never verified on receive.

## DX / TYPES / DOCS
- DX-1 FieldBuilder phantom params Req/Auto unused structurally (core/src/schema/types.ts ~27-36): insert({}) and insert({title:1}) compile; optional fields typed non-null; type tests vacuous (infer.test.ts ~74, 115, 129).
- DX-2 where/orderBy/include/transaction proxy/useCollection untyped; t.object infers Record<string,unknown>; t.array(t.enum) infers string[]; .default(unknown).
- DX-3 Docs wrong: useMutation(app.todos.insert) then addTodo(...); useRichText signature; "no loading state"; "enable sync in one line"; README status version.
- DX-4 findById before ready returns null silently while others throw AppNotReadyError.
- DX-5 useMutation returns new functions each render and resubscribes; no StrictMode regression test for useMutation.
- DX-6 SSR: module-scope createApp opens better-sqlite3 during server render; useQuery has no getServerSnapshot.
- DX-7 Vue useQuery takes value not getter/ref (not reactive to prop changes).
- DX-8 Deploy prompt offers Render and Docker which throw "not implemented".
- DX-9 Collection named `sync`/`events` silently shadowed on app object.
- DX-10 dynamic-serializer imports bare 'protobufjs' (may fail under Node ESM).

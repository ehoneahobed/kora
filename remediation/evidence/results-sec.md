# SEC verification results (SEC-1 .. SEC-9, plus NEW-SEC-1)

All repro tests assert the CORRECT behavior, so they fail today. Reproductions run against a real `KoraSyncServer` over `createServerTransportPair` (memory transport) with a `TokenAuthProvider` that returns per-tenant `scopes` (the documented multi-tenant setup), a real `createProductionServer`, a real `Store` on better-sqlite3, or the `@korajs/test` network harness (real `SyncEngine` + SQLite devices + `KoraSyncServer`).

Run with:
- `cd packages/server && npx vitest run tests/repro/<ID>.test.ts`
- `cd packages/test && npx vitest run tests/repro/SEC-3.test.ts`
- `cd packages/store && npx vitest run tests/repro/SEC-7.test.ts`
- `cd packages/sync && npx vitest run tests/repro/SEC-8.test.ts`

| ID | Verdict | Severity | Effort |
|----|---------|----------|--------|
| SEC-1 | CONFIRMED | P0 | S |
| SEC-2 | CONFIRMED (plus an insert-overwrite variant) | P0 | M |
| SEC-3 | CONFIRMED for nodeId forgery causing data loss and divergence; the op.id part is true but low value | P1 | M |
| SEC-4 | CONFIRMED | P2 | S |
| SEC-5 | CONFIRMED (all sub-claims) | P0 for yjs leak, P1 for presence/blob | M |
| SEC-6 | CONFIRMED (takeover by update, takeover by insert, limit before scope) | P1 | S-M |
| SEC-7 | CONFIRMED; impact is limited (local DB, needs untrusted input that bypasses the TS types) | P3 | S |
| SEC-8 | CONFIRMED (intentional and documented, but harmful and unnecessary) | P2 | S |
| SEC-9 | PARTIAL: XFF trust and quote escaping CONFIRMED; backdating REFUTED as a security issue | P2 / P3 | S |
| NEW-SEC-1 | CONFIRMED | P3 | S |

---

## SEC-1: operation-batch accepted before handshake (unauthenticated write)
- **Verdict:** CONFIRMED.
- **Evidence:** `packages/server/tests/repro/SEC-1.test.ts`. Setup: server with auth, bob authenticated with scope `todos.userId=bob`. A second connection never sends a handshake and sends one `operation-batch` with `data.userId='bob'`. Result:
  - `expected 1 to be +0`: the op was persisted.
  - `expected [ { id: 'evil-op-1', …} ] to have a length of +0 but got 1`: the op was relayed into bob's session.
  - `expected true to be false`: the attacker received an acknowledgment.
- **Location:**
  - `packages/server/src/session/client-session.ts:638-645`: `handleMessageAsync` has no state gate.
  - `client-session.ts:1340-1346`: `operationAllowedFromClient`. With `authContext` null, scopes are undefined.
  - `packages/server/src/scopes/server-scope-filter.ts:70`: `if (!scopes) return true`.
- **Root cause:** Message dispatch never checks that the handshake (and therefore authentication) succeeded. An unauthenticated session has no scopes, and no scopes means allow everything.
- **Fix:**
  - In `ClientSession.handleMessageAsync`, reject every type except `handshake` unless `state` is `syncing` or `streaming`. Send `HANDSHAKE_REQUIRED` (non-retriable) and `close()`.
  - Also make `operationAllowedFromClient` fail closed: when `this.auth` is set and `this.authContext` is null, return false.
  - Invariant: no operation is applied, and no side-channel message is relayed, for a session that has not completed an accepted handshake.
- **Regression risk:** Low. Real clients always handshake first, because messages are serialized through `messageChain`. Some unit tests may send batches without a handshake and would need one added.
- **Severity / effort:** P0 (any deployment with auth configured) / S.

## SEC-2: upload scope check trusts client previousData/data, not the stored row
- **Verdict:** CONFIRMED, plus a closely related variant.
- **Evidence:** `packages/server/tests/repro/SEC-2.test.ts`. Alice is authenticated with scope `userId=alice`; bob's record already exists on the server.
  - Update `{title:'hacked'}` with forged `previousData:{userId:'alice'}`: accepted and acked (`expected false to be true`), and bob's row changed (`expected 'hacked' to be 'bob secret'`).
  - Delete with forged `previousData:{userId:'alice'}`: bob's row was soft-deleted (`expected [] to have a length of 1 but got +0`).
  - Update `data:{userId:'alice'}`: bob's record now belongs to alice (`expected 'alice' to be 'bob'`).
  - Variant: insert reusing bob's `recordId` with `userId:'alice'` overwrites bob's record (`expected 'mine now' to be 'bob secret'`).
- **Location:**
  - `packages/server/src/scopes/server-scope-filter.ts:123-145`. `missingScopeFields` skips the stored-row lookup whenever data/previousData carries the field. `buildSnapshot` precedence is `fullRecord < previousData < data`.
  - `client-session.ts:1340-1346`.
- **Root cause:** Authorization is computed from attacker-controlled op fields. The stored row's current scope values are never required to match, and a client value overrides them.
- **Fix:**
  - Add `authorizeUplinkWrite(op, storedRow, scopes)` in `server-scope-filter.ts`, used by `operationAllowedFromClient`. When scopes exist, always load the stored row (`includeDeleted: true`). Then require:
    - (a) if a stored row exists, it matches the scope using stored values only. This applies to insert, update and delete.
    - (b) the post-image `{...storedRow, ...op.data}` (inserts use `op.data`) matches the scope.
  - Never read `previousData` for authorization.
  - Invariant: an op may only touch a record that is in the uploader's scope both before and after the write.
  - Ideally run the check inside the store apply path (or under the same lock) to avoid a race between check and apply. This matters for Postgres with multiple instances.
- **Regression risk:** Medium.
  - Legitimate ownership-transfer updates by clients become `SCOPE_VIOLATION`; these must move to server routes.
  - It adds one row lookup per uploaded op.
  - An update whose insert has not yet materialized has no stored row and is judged on the post-image only (same as today).
- **Severity / effort:** P0 (any authenticated tenant can edit, delete or take over any other tenant's records) / M.

## SEC-3: op.nodeId not bound to the session; forged high sequenceNumber causes data loss
- **Verdict:** CONFIRMED (nodeId forgery, data loss and divergence). The "op.id never verified" part is true but low value: the id is an unkeyed SHA-256 that an attacker can compute, and it cannot be verified server-side for E2E-encrypted or schema-transformed ops, because the hash covers plaintext `data`.
- **Evidence:** `packages/test/tests/repro/SEC-3.test.ts`, using the real SyncEngine devices and KoraSyncServer.
  - Test 1: a raw peer that handshakes as `mallory-node` uploads an op with `nodeId: 'victim-node-id'` and `id: 'not-a-content-hash'`. It is stored (`expected true to be false`).
  - Test 2: the attacker forges one op under the victim's real nodeId with `sequenceNumber 1_000_000`. The victim reconnects once, goes offline, writes two records, and reconnects.
    - Server: `expected [ 'forged' ] to include 'offline write 1'` (and `'offline write 2'`).
    - Observer: `expected [ 'forged' ] to include 'offline write 1'`.
    - The victim and observer never converge: `expected [ Array(2) ] to deeply equal [ 'forged' ]`. The victim never receives the forged op because the resume stream skips ops whose nodeId equals the receiver.
  - The loss is silent. The victim's pending count shows 0.
  - Note: without the intervening reconnect, the writes survive, because `reconcileOutboundFromOpLog` ran with the old vector. The loss needs one handshake that persists the poisoned vector, which happens on any normal reconnect.
- **Location:**
  - `packages/server/src/session/client-session.ts:943+` (`handleOperationBatch`, no `op.nodeId === clientNodeId` check) and `:724` (`clientNodeId` is client-chosen and not bound to the principal).
  - `memory-server-store.ts` `applyRemoteOperation` advances the vector to any seq.
  - Client trust of the server vector: `packages/sync/src/engine/sync-engine.ts:1157` (`persistLastAckedServerVector(remoteVector)`), `:1350-1362` (`collectDelta`), `:1795` (`advanceLastAckedForLocalNode`) and `:1867` (`reconcileOutboundFromOpLog`).
  - Skip-own logic: `client-session.ts:1228`.
- **Root cause:** The server accepts any nodeId and sequenceNumber from any session. The client treats the server-advertised vector entry for its own nodeId as proof that its ops are stored.
- **Fix:**
  - Server, in `handleOperationBatch`: reject with `NODE_ID_MISMATCH` (non-retriable) when `op.nodeId !== this.clientNodeId` or `op.timestamp.nodeId !== op.nodeId`.
  - Server, in `handleHandshake`: bind nodeId to the principal. Add `ServerStore.claimNode(nodeId, userId)` and reject the handshake when the nodeId is owned by another userId (only when auth is configured).
  - Client: never let a server-advertised vector mark its OWN node's ops as synced. For `self`, use `min(serverVector[self], highest seq actually acknowledged)` in `persistLastAckedServerVector`, `collectDelta` and `reconcileOutboundFromOpLog`.
  - Optionally verify `op.id` only when the op is neither encrypted nor transformed.
  - Invariant: only the owning principal can advance `serverVector[nodeId]`, and a client only drops its own op after an ack covering it.
- **Regression risk:** Medium.
  - Users who share a local store across sign-ins (same nodeId, different userId) need a fresh nodeId per user.
  - Tests that upload ops with arbitrary nodeIds and no auth are unaffected if the binding is enforced only under auth. The client-side min() change touches ack bookkeeping.
- **Severity / effort:** P1 (permanent, silent loss of a victim's offline writes plus divergence; any authenticated user can do it, and with SEC-1 so can an unauthenticated one; the victim nodeId comes from SEC-4) / M.

## SEC-4: handshake response leaks the full server version vector
- **Verdict:** CONFIRMED.
- **Evidence:** `packages/server/tests/repro/SEC-4.test.ts`. Alice (scope `userId=alice`) receives `versionVector` containing bob's device nodeId: `expected [ 'bob-device-node-id' ] to not include 'bob-device-node-id'`.
- **Location:** `packages/server/src/session/client-session.ts:876` (accepted response) and `:858` (schema-mismatch response).
- **Root cause:** `versionVectorToWire(this.store.getVersionVector())` is sent unfiltered. It exposes every device id in every tenant and per-device write counts. This is the targeting input for SEC-3.
- **Fix:** In `handleHandshake`, send only the entries whose nodeId appears in the client's handshake `versionVector` plus `msg.nodeId`. The client only reads entries for nodes in its local vector (`collectDelta`, `persistLastAckedServerVector`). Send `{}` on the reject path.
- **Regression risk:** Low. Check DevTools or status consumers that display `remoteVector`.
- **Severity / effort:** P2 / S.

## SEC-5: yjs, awareness and blob relays bypass auth and scope
- **Verdict:** CONFIRMED (every sub-claim).
- **Evidence:** `packages/server/tests/repro/SEC-5.test.ts`.
  - A never-handshaken connection injects a `yjs-doc-update` and an `awareness-update` into authenticated bob's session (both `expected true to be false`).
  - Bob's `yjs-doc-update` is received by a never-handshaken eavesdropper and by alice, another tenant (both `expected true to be false`).
  - 1000 unauthenticated `blob-chunk-request`s are forwarded to bob (`expected true to be false`) and tracked (`expected 1000 to be +0`, unbounded `pending` map).
  - An unauthenticated `blob-chunk-push` is persisted (`expected [ Array(1) ] to have a length of +0 but got 1`).
- **Location:**
  - `packages/server/src/server/kora-sync-server.ts:704-705`: relays registered at connect time.
  - `kora-sync-server.ts:866-876`: `handleAwarenessRelay` registers on first update.
  - `packages/server/src/session/client-session.ts:663-676` and `:686-697`: no state gate.
  - `packages/server/src/richtext/yjs-doc-relay.ts`: `broadcastExcept` to all clients.
  - `blob-chunk-relay.ts:124`: unbounded `pending`.
  - `awareness-relay.ts`: `handleUpdate` broadcasts the whole `states` map, so a sender can also overwrite or remove other clients' entries.
  - The ws transport sets no `maxPayload` (ws default is 100 MiB).
- **Root cause:** The side channels were built as unauthenticated broadcast buses with no session state, tenant or scope awareness.
- **Default-config impact:** The client automatically uses the doc channel for any richtext doc of 4096 bytes or more (`DEFAULT_RICHTEXT_DOC_CHANNEL_THRESHOLD`; `create-richtext-controller.ts` uses `shouldUseChannel`). Live rich-text edits therefore leak across tenants. Incoming updates are applied to the open editor (`Y.applyUpdate`), so an injected update becomes durable on the victim's next local edit (that last step is from code reading).
- **Fix:**
  - (1) Register sessions with the yjs, blob and awareness relays only once they reach `streaming` (add an `onReady` callback), and remove the eager adds at `:704-705`. Together with the SEC-1 gate, drop side-channel messages before handshake.
  - (2) yjs-doc-update: the sender must pass the SEC-2 write check for `(collection, recordId)` against the stored row. Deliver only to sessions whose downlink scope contains that stored row (look up once per message).
  - (3) awareness: bind `clientId` to the session on first update, accept only `states[String(boundClientId)]` from that sender, and relay only to sessions in the same scope partition. A minimal version keys the partition by the canonical scope map; the better version scopes presence by a referenced record.
  - (4) blob: require an authenticated session; cap `pending` per session (for example 256) with a TTL; for `blob-chunk-push`, enforce a byte limit, a per-session quota, and only accept hashes referenced by a BlobRef in an op the session uploaded (or its manifest).
  - (5) Set `maxPayload` on the WebSocketServer.
- **Regression risk:** Medium. Collaborative presence across tenants is impossible by design after the fix. Blob pulls between two devices of the same user must still work (same scope).
- **Severity / effort:** P0 for yjs content leak and injection in a default multi-tenant config; P1 for awareness and presence leak and spoofing; P2 for blob forward (the hash acts as a capability), pending-map DoS and unauthenticated persistence (disk fill). Effort M.

## SEC-6: route-context (`request.kora`) scope checks only the built op; query applies limit before scope
- **Verdict:** CONFIRMED.
- **Evidence:** `packages/server/tests/repro/SEC-6.test.ts`, using `createRouteContext(server, store)` as wired by the production server.
  - `apply({type:'update', recordId:'bob-0', data:{userId:'alice', ...}}, {scope:{notes:{userId:'alice'}}})` returns ok (`expected true to be false`) and bob's row now belongs to alice (`expected 'alice' to be 'bob'`).
  - A scoped insert reusing `bob-1` overwrites it (`expected 'alice' to be 'bob'`).
  - `query('notes', {limit:1, scope})` returns `[]` instead of alice's record (`expected [] to deeply equal [ 'alice-1' ]`).
  - Deletes are correctly rejected, because previousData is the full current row.
- **Location:** `packages/server/src/server/route-context.ts:344` (and `:449` on the store conditional path): `operationMatchesScopes(op, scope)` without the stored row. For updates, `previousData` only holds the changed keys (`:250`) and `data` wins in the snapshot; inserts never read the current row. The query issue is at `:598-604` (store applies limit/offset, then filter).
- **Root cause:** Same as SEC-2. The scope is checked against the post-write op snapshot, not against the stored row's ownership, and query pagination runs before the scope filter.
- **Fix:**
  - In `prepareMutation` (and the store-conditional builder), read `current` (`findRecord` including deleted) and call the shared `authorizeUplinkWrite(op, current, scope)` from SEC-2. This rejects when `current` exists out of scope, including for insert.
  - In `query()`, pass equality scope predicates into `queryCollection`'s `where` so limit and offset apply after scoping. For `$in`, fetch without limit, filter, then slice.
  - Replace `recordMatchesScope` with the shared `matchesPredicate` (see NEW-SEC-1).
- **Regression risk:** Low-medium. Routes that intentionally reassign ownership under a scope must drop the scope or use an explicit admin path.
- **Severity / effort:** P1 (needs a developer route that forwards client data with a scope, which is the documented pattern) / S-M.

## SEC-7: SQL injection via orderBy direction, limit, offset (client store)
- **Verdict:** CONFIRMED; the impact is limited.
- **Evidence:** `packages/store/tests/repro/SEC-7.test.ts`, using a real `Store` on better-sqlite3.
  - `orderBy('title', "ASC LIMIT (SELECT COUNT(*) FROM secrets WHERE value LIKE 'TOP%')")` executes and returns a row, a boolean oracle over another collection (`expected [ {…} ] to have a length of +0 but got 1`; no error thrown, `expected false to be true`).
  - The same holds for `limit("(SELECT CASE WHEN (SELECT value FROM secrets) LIKE 'TOP%' THEN 10 ELSE 0 END)")`.
  - UNION payloads fail in SQLite because `ORDER BY`/`LIMIT` must come after a UNION, so the vector is subqueries and oracles, not direct UNION exfiltration.
  - Server stores (`sqlite-server-store.ts:515`, `postgres-server-store.ts:720`) whitelist the direction and bind limit/offset, so they are safe.
- **Location:** `packages/store/src/query/sql-builder.ts:42, 48, 52`; `query-builder.ts:66-91` has no validation.
- **Root cause:** Values typed as `'asc'|'desc'` and `number` are interpolated without runtime validation.
- **Fix:**
  - In `buildSelectQuery`, map direction through `{asc:'ASC', desc:'DESC'}` and throw `QueryError` otherwise.
  - Bind limit and offset as `?` params after asserting `Number.isSafeInteger(n) && n >= 0`.
  - Validate early in `QueryBuilder.limit`/`offset`/`orderBy`.
- **Regression risk:** Low.
- **Severity / effort:** P3 (the local DB holds only the user's own data, and exploitation needs the app to pass untrusted strings through a type cast) / S.

## SEC-8: auth token sent as a URL query parameter
- **Verdict:** CONFIRMED. It is intentional (`docs/api/sync.md:269`, and existing tests `websocket-transport.test.ts:84-97` assert it), but harmful: the server never reads the URL token (the `production-server.ts:589` upgrade handler ignores it), while `SyncEngine` already sends it in `handshake.authToken` (`sync-engine.ts:457`).
- **Evidence:** `packages/sync/tests/repro/SEC-8.test.ts`: `expected 'wss://sync.example.com/kora?token=eyJ…' not to contain 'eyJ.secret.jwt'`.
- **Location:** `packages/sync/src/transport/websocket-transport.ts:114-117`.
- **Root cause:** The bearer token is duplicated into the URL, where reverse proxies, load balancers, access logs and APM tools record it.
- **Fix:** Stop appending `token=` in `WebSocketTransport.connect`, and keep only the handshake token. If some proxy needs it, add an explicit opt-in (`tokenInUrl: true`). Update the two existing tests and the docs line.
- **Regression risk:** Low (no in-repo consumer of the URL token).
- **Severity / effort:** P2 / S.

## SEC-9: backdated timestamps, X-Forwarded-For trust, unescaped DDL defaults
- **Verdict:** PARTIAL.
- **(a) getClientIp trusts X-Forwarded-For: CONFIRMED.**
  - Evidence: `packages/server/tests/repro/SEC-9.test.ts` (a). A direct request with `X-Forwarded-For: 203.0.113.77` to a real `createProductionServer` route gets `request.ip === '203.0.113.77'` (`expected '203.0.113.77' not to be '203.0.113.77'`).
  - Location: `packages/server/src/server/production-server.ts:320-326`. It is consumed as the rate-limit key by `@korajs/auth` (`quickstart-server.ts:201,204` and `auth-routes.ts:325,447`).
  - Impact: rotating the header gives a fresh sign-in or sign-up rate-limit bucket on every request (brute force).
  - Fix: use `req.socket.remoteAddress` unless `ProductionServerConfig.trustProxy` (a hop count or CIDR list) is set. When it is, take the right-most XFF entry that is not a trusted proxy.
  - Risk: low (deployments behind a proxy must set `trustProxy`). P2 / S.
- **(b) sqlDefaultLiteral does not escape quotes: CONFIRMED as a correctness bug, not a security one.**
  - Evidence: SEC-9 (b). `t.string().default("don't know")` makes `SqliteServerStore.setSchema` throw `SqliteError: near "t": syntax error`.
  - Location: `packages/server/src/store/materialization.ts:53-59`; the enum CHECK at `:85` has the same problem.
  - The input is the developer-authored schema, not attacker data.
  - Fix: escape `'` as `''` in `sqlDefaultLiteral` (string and JSON branches) and in the enum values.
  - Risk: low. P3 / S.
- **(c) Old-timestamp ops accepted (wallTime:1): REFUTED as a security issue.**
  - `isOperationTimestampValid` (`operation-validation.ts:17-26`) does accept any past wallTime. But a backdated op only makes the attacker's own write lose LWW.
  - First-write-wins unique constraints do not let it win either: the server arbitrates by arrival. `validateIncomingOperationConstraints` rejects the later-arriving violator regardless of HLC.
  - No harm to other principals was found. No test kept for this part.

## NEW-SEC-1: route-context recordMatchesScope ignores `$in` predicates
- **Verdict:** CONFIRMED.
- **Evidence:** `packages/server/tests/repro/NEW-SEC-1.test.ts`. With scope `{notes:{orgId:{$in:['org-a','org-b']}}}`, `findById` returns null (`expected null not to be null`) and `query` returns `[]` for an in-scope record.
- **Location:** `packages/server/src/server/route-context.ts:145-158` (`record[field] !== expected`).
- **Root cause:** It duplicates the scope matching from `server-scope-filter.ts` without `$in` support, while `apply()` uses `operationMatchesScopes`, which does support it.
- **Fix:** Export `matchesPredicate` from `server-scope-filter.ts` and use it in `recordMatchesScope`.
- **Regression risk:** Low.
- **Severity / effort:** P3 (fails closed, so availability only) / S.

## Repro files created
- `packages/server/tests/repro/SEC-1.test.ts`, `SEC-2.test.ts`, `SEC-4.test.ts`, `SEC-5.test.ts`, `SEC-6.test.ts`, `SEC-9.test.ts`, `NEW-SEC-1.test.ts`
- `packages/test/tests/repro/SEC-3.test.ts`
- `packages/store/tests/repro/SEC-7.test.ts`
- `packages/sync/tests/repro/SEC-8.test.ts`

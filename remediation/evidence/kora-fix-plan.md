# Kora.js Fix Plan

Prepared 2026-10-01 against `main` at 91c6350 (packages at 1.0.0-beta.12). Companion to `kora-framework-dossier.md`.

**Revision 2 (2026-10-01, later the same day):** adds the verified intake of the Bozoma Innovation Hub LMS team's 13 recommendations. The verdicts and the 20 new problems they led to are in §9, and the totals below include them.

## 0. How this plan was verified

Every problem in this plan was checked twice by people other than the reviewer who first reported it:

1. **Independent re-verification.** Six fresh reviewers took the 73 claims from the first review, treated each as unproven, traced the code end to end, and tried to reproduce it through realistic entry points: `createApp`, the documented auth quickstart, a real `KoraSyncServer`, real devices over in-memory transports, and a real Postgres 16 cluster for the multi-instance claims. Surviving claims got a reproduction test that asserts the **correct** behavior, so it fails today and passes once fixed.
   - 80 of the 86 problems have a dedicated repro.
   - The other six were confirmed another way:
     - NEW-SRV-1, NEW-SRV-2 and NEW-SRV-3 surfaced inside the SRV-7, SRV-4 and SRV-2 repros.
     - NEW-DX-1, NEW-DX-2 and STORE-16 were confirmed by reading the code.
   - Some sub-facets of SRV-6 (handshake deadline, heartbeat, `maxConnections`, batch cap) and SEC-5 (`maxPayload`) were also confirmed by reading.
   - Each of these gets an explicit acceptance check in its workstream.
2. **Re-run audit.** I re-ran all 149 reproduction tests twice. Results were identical both times (no flakes), and every failure is the defect itself, not a setup error.
   - Five tests pass by design: they are controls proving the harness works.
   - The four SRV-4 tests skip without Postgres. I ran them against a real Postgres 16, and all four fail as claimed.
3. **Plan review.** A third independent reviewer audited this plan against the evidence. It found 17 design and sequencing problems, including three fix designs that would have created new bugs. All 17 are incorporated below and marked *(review)*.
4. **External report intake (§9).** Four further independent verifiers tested the LMS team's 13 claims and the fixes they proposed. They used real Chromium with real OPFS for the storage claims and a real Postgres 16 for the server claims. I re-ran every resulting test twice, with identical results. That added 20 new problems, marked *(LMS)*.

| Outcome | Count |
|---|---|
| Original claims confirmed in full | 63 |
| Original claims confirmed in part (some sub-claims refuted) | 9 |
| Original claims refuted outright | 1 (DX-10) |
| New defects found during verification | 14 |
| New problems from the LMS report intake (§9) | 20 |
| **Problems in this plan** | **106** |
| Reproduction tests, first review (81 files) | 149: 144 fail as intended, 5 passing controls |
| Reproduction tests, LMS intake (Node, Postgres, real Chromium) | 79 Node tests (46 fail as intended; 33 guards, benchmarks and pins of defects in the proposed fixes) and 25 browser checks (14 fail as intended). One further offline-reload check fails as intended. |

**Refuted, so excluded from the plan:**
- DX-10 (bare `protobufjs` import works in Node ESM).
- SEC-9(c) (backdated timestamps only hurt the attacker's own write).
- SRV-1 "update revives a deleted record" (client and server use the same fold here, so they agree).
- SRV-2 "move-out leaves stale copy" (documented `scopeExit:'retain'` behavior) and "scope narrowing sends no retractions" (handled client-side under `retract`).
- SYNC-7 NaN skew (unreachable with Kora's server).
- CORE-1 "causalDeps always empty". This was my error in the dossier: user ops do carry the previous local op in the same collection. They never carry cross-device causality.
- STORE-3 delete sub-claim (not reachable through the public API; fixed anyway because it is one line).

**Severity scale:**
- P0: data breach or silent data loss/divergence in default or documented config.
- P1: the same, under common but non-default config, or a lockout.
- P2: degraded correctness, DoS lever, or a misleading API.
- P3: hygiene.

**Severity changes after verification:**
- **Upgraded:**
  - MERGE-2 is now P0 (permanent divergence between clients, even with two devices).
  - STORE-1 is worse than reported: the public `app.transaction` path never persists the sequence counter, so a later write is never uploaded.
  - SYNC-11 is a sync wedge after the first reconnect on any auth-scoped server, not just extra rescans.
- **Downgraded:**
  - SEC-7 is now P3 (only touches the local DB and needs a type-cast bypass).
  - SYNC-9 is now P3 (protobuf is not on the default path).

---

## 1. Shape of the work

The 106 problems collapse into **13 root causes**. The LMS intake added no new root cause; every new problem landed in an existing workstream. Fixing by root cause, not by item, is what keeps this tractable and stops the same bug re-appearing in a sibling code path.

| WS | Root cause | Problems | Top sev | Effort (eng-days) |
|---|---|---|---|---|
| W0 | Safety net: tests encode bugs, no invariant gates | process | n/a | 4 to 6 |
| S1 | P0 stopgaps that ship in the Phase 1 security release *(review)* | STORE-4, SYNC-1 (predicate), STORE-1 (counter), MERGE-1 + NEW-MERGE-1 (interim), NEW-STORE-6/7 (interim) *(LMS)* | P0 | 3 to 4 |
| W1 | Server trusts client-built state at the trust boundary | SEC-1, 2, 3(server), 4, 5, 6, 8, 9a, NEW-SEC-1, NEW-SEC-2 *(LMS)* | P0 | 8 to 11 |
| W2 | Auth: scopes are client-chosen; credential lifecycle has holes | AUTH-1 to 14, NEW-AUTH-1, NEW-AUTH-2 to 4 *(LMS)* | P0 | 14 to 18 |
| W3 | Upstream "synced" is a max, not a contiguous acknowledged prefix | SYNC-1, 4, 6, SEC-3(client) | P0 | 7 to 9 |
| W4 | Downstream applies or skips without a durable record | SYNC-2, 3, 7, 11, NEW-SYNC-1, SRV-2, NEW-SRV-3, SRV-3, SRV-5, NEW-SYNC-3, 4, NEW-SRV-7 *(LMS)* | P1 | 9 to 12 |
| W5 | Connection lifecycle state is split between engine and transport | SYNC-5, 8, 10, NEW-SYNC-2, SRV-6 (heartbeat/timeouts) | P1 | 4 to 5 |
| W6 | Local write paths diverge (transaction path is a second, weaker copy) | STORE-1, 2, 3, 4, 8, 9, 10, 15, NEW-STORE-2, NEW-STORE-3 | P0 | 5 to 7 |
| W7 | No single definition of record state (three different folds) | MERGE-1, MERGE-2, NEW-MERGE-1, SRV-1, SRV-7, CORE-1, STORE-14 | P0 | 25 to 35 |
| W8 | Durability edges bypass the canonical op format or the browser's storage rules | W8a (Phase 2): NEW-STORE-5 to 10 *(LMS)*. W8b (Phase 3): STORE-5, 6, 7, 13, NEW-STORE-1 | P0 | 14 to 19 |
| W9 | Encryption has no shared key material and no integrity binding | ENC-1, 2, 3, NEW-ENC-1 | P1 | 4 to 6 |
| W10 | Server stores cache cluster state per process; no resource limits | SRV-4, NEW-SRV-1, NEW-SRV-2, SRV-6 (limits), NEW-SRV-4, 5, 6 *(LMS)* | P1 | 7 to 10 |
| W11 | Type inference is structurally vacuous | DX-1, DX-2 | P1 | 5 to 7 |
| W12 | DX, docs, hooks, hygiene and the offline app shell | DX-3 to 9, NEW-DX-1, 2, STORE-11, 12, 16, SEC-7, SEC-9b, SYNC-9, NEW-DX-3, NEW-STORE-4, NEW-STORE-11, NEW-SRV-8 *(LMS)* | P1 | 9 to 12 |
| | **Total** | **106** | | **~118 to 161** |

Effort is engineer-days for one engineer who knows the codebase, including tests, migrations and docs. For a solo engineer that is roughly 6 to 8 months. W1/W2, W3/W4/W5/W6 and W9/W10/W11/W12 can run as parallel tracks once their dependencies land, which is where a second engineer (or supervised AI agents working from the repro tests) cuts calendar time. W7 is the long pole, and the earlier W7 estimate of 12 to 16 days was too low *(review)*: it also has to cover the protocol v2 compatibility window, the client and three server-store migrations, side-effect authority, and running the old pipeline alongside for comparison.

---

## 2. Cross-cutting decisions (yours to make before Phase 1)

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Accept breaking changes in the next beta? | (a) yes, beta.13 is a breaking beta; (b) keep compat shims for everything | **(a).** Several fixes are breaking by nature: scopes become server-granted, client ownership transfer is blocked, stricter types, wire format. Kora is still in beta, so this is the cheapest moment it will ever be. |
| D2 | Batch the wire-format breaks | (a) one protocol bump (v2) carrying all three; (b) ship each when ready | **(a)** Protocol v2 carries: op id hash covering all fields (CORE-1), encryption envelope v2 with AAD (ENC-3), and the `SEQUENCE_CONFLICT` rule for duplicate (node, seq) pairs (W3). One migration, one compatibility window, one release note. |
| D3 | Array and object merge semantics | (a) state-based CRDT: arrays as an LWW element set (per-element HLC plus removal markers), objects as per-key LWW registers with removal markers; (b) true OR-set with unique add tags (add-wins, needs causal metadata) | **(a).** It is commutative, associative and idempotent by construction, needs no replay, and survives compaction and late offline ops *(review: the earlier "fold by replay" idea broke under compaction)*. Semantics, in plain words:<br>• Arrays are sets: duplicates collapse, and elements are ordered by first-add timestamp.<br>• Removal beats unchanged.<br>• For the same element, the later edit wins.<br>• Objects merge per top-level key.<br>Apps that need ordered lists with duplicates get a future `t.list()` (sequence CRDT); that is out of scope here. |
| D4 | Encryption key material | (a) deterministic salt from config (app id + user id); (b) server-stored encrypted key envelope | **(b)** for real multi-device use. (a) is acceptable as a stopgap behind a flag. |
| D5 | Ownership transfer | Client writes that change a scope field across tenants become illegal | Route-only (`request.kora` with an explicit admin path). This is the price of SEC-2. |
| D6 | Status of the published beta.12 | Silent, or publish a security advisory | **Publish an advisory.** The npm package has P0 multi-tenant holes (SEC-1, SEC-2, AUTH-1). Anyone deploying it multi-tenant today is exposed. Say so in README and the GitHub security tab, and do not tag it stable. |

---

## 3. Phased roadmap

```
Phase 0  Safety net + advisory                         4 to 6 eng-days    W0, D6
Phase 1  Trust boundary + P0 stopgaps (beta.13)        25 to 33           W1, W2, S1
Phase 2  No silent loss                                34 to 45           W3, W4, W5, W6, W8a (OPFS), SRV-4 (moved up)
Phase 3  One fold + durability (beta.14, protocol v2)  33 to 46           W8b (repair first), W7, W9 envelope
Phase 4  Encryption, scale, types, DX (RC)             22 to 31           W9 rest, W10 rest, W11, W12
                                                       ---------
                                               Total   118 to 161
```

**Dependency rules:**
- W0 precedes everything.
- W1's `authorizeUplinkWrite` precedes W2 step 1 (scope intersection uses the same check).
- **The SRV-4 Postgres fixes (vector read from the database, transactional dedup, BIGINT) move into Phase 2** *(review)*. W1's `claimNode` and W3 both read the server vector, which today is a per-process cache.
- W3 and W6 precede W7. The fold needs every op to reach the server, unique sequences, and ops built after their sequence is reserved.
- **W8's backup and log-integrity work precedes W7's re-materialization** *(review)*. Rebuilding from a log corrupted by beta.12 backup restore (null `wallTime`) or by compaction would bake the damage in, so W8 first adds a log-integrity scan that detects and repairs those rows.
- CORE-1's hash change ships inside W7's protocol v2, together with W9's envelope.

**Work that W7 later replaces** *(review)*. S1's MERGE-1 formula fix and NEW-MERGE-1 one-liner are deliberately throwaway. They stop new divergence on two-device setups now, at a cost of under a day. W6's per-field stamp fix (STORE-3) must be designed once, in the shape W7's per-field metadata needs, so it is not rewritten.

**Release cadence:**
- Each phase ends in a beta with its repro tests green.
- Phase 1 ends in beta.13: a security and P0-stopgap release. Ship it as soon as it is done.
- Phase 3 ends in beta.14 (protocol v2).
- Phase 4 ends in the RC.

---

## 4. Workstreams in detail

Each problem lists its repro test(s), which become permanent regression tests once green.

### W0. Safety net (Phase 0)

**Why:** the suite is green while 106 defects exist. Five existing tests assert buggy behavior, and the type tests are vacuous. Without this, fixes will be "reverted" by tests that look authoritative.

**Tasks:**
1. Commit the 81 repro files (patch provided with this plan) and add a `test:repro` script, backed by a manifest (`repro-manifest.json`) that records each test's expected state: `failing`, `fixed`, or `control`.
   - CI blocks when a `fixed` test fails (a regression) and when a `failing` test starts passing without its manifest entry being updated (proof a fix landed).
   - This replaces blanket `it.fails`, which does not work here *(review)*: two tests are timing-based (SRV-3, SRV-7), five are passing controls, and SRV-4 skips without Postgres.
   - Run SRV-3 and SRV-7 in a separate, non-blocking performance job.
   - Add a Postgres service to CI so SRV-4 actually runs.
   - The `tsc` probes (DX-1, DX-2) use a recorded expected-error baseline until W11 lands.
2. Invert or delete the five tests that encode bugs. Each goes in the PR that fixes the matching defect:
   - `sync-engine.test.ts:2038-2065` (SYNC-1)
   - `add-wins-set.test.ts:26-47, 120-130` (MERGE-1)
   - `websocket-transport.test.ts:84-97` (SEC-8)
   - `resolve-session-scopes.test.ts:38` (AUTH-1)
   - `password-reset.test.ts:34-56` (AUTH-7)
3. Add two invariant gates to `test:release-gate`:
   - **Convergence property test.** Generalize `packages/test/tests/repro/MERGE-2.test.ts` to N replicas plus server, all field kinds, random order, drop and duplicate, 200 seeds. Assert every replica equals the server, and both equal the merge of the full op set computed from scratch.
   - **Hostile-client suite.** Generalize SEC-1/2/3/5 and AUTH-1 into a reusable "malicious peer" harness: forged nodeId, forged previousData, pre-handshake messages, cross-tenant scope, side channels.
4. Replace vacuous type tests (`infer.test.ts:74, 83, 115, 129`) with `expectTypeOf().toEqualTypeOf()` plus `@ts-expect-error` negatives. Wire `tsc --noEmit` over `kora/tests/repro/types/*.ts` into CI.
5. Hygiene: gitignore and untrack `packages/store/:memory:backup-*` (test artifacts rewritten on every run).

**Done when:** CI runs `test:repro` and both invariant gates; the five bug-encoding tests are tracked as TODO-invert.

**Acceptance checks for the six problems without a dedicated repro.** Write each as a test when its workstream starts:
- NEW-SRV-1 (memory-store write cost is O(record), not O(log)).
- NEW-SRV-2 (a concurrent duplicate on Postgres yields exactly one cascade).
- NEW-SRV-3 (no orphan update survives a scope entry).
- NEW-DX-1 (`useCollaborators` renders under `renderToString`).
- NEW-DX-2 (no dead serializer in the package graph).
- STORE-16 (benchmark gates run in a real browser).

The SRV-6 and SEC-5 code-read facets each get a test too: handshake deadline, heartbeat, `maxConnections`, batch cap, `maxPayload`.

### S1. P0 stopgaps (Phase 1, ship in beta.13) *(review)*

These are small, independently safe changes that stop active data loss or leaks while the structural fixes are built. Each makes its repro pass, or the relevant part of it.

| Fix | Change | Replaced later by |
|---|---|---|
| STORE-4 | Call `transformSecretFieldsForWrite` in `TransactionContext` insert and update; pass `secretKeyProvider` into its config. | Stays (W6 routes through the same helper) |
| SYNC-1 | Split the predicate: uploads check the uplink scope only, never query subsets. Invert `sync-engine.test.ts:2038`. | Stays (W3 step 1) |
| STORE-1 (counter) | `ApplyPipeline.commitTransaction` writes `_kora_version_vector` with `MAX(existing, highest seq in batch)` inside the commit transaction. This stops later writes being reported as synced, but does not yet prevent concurrent duplicates. | W6 block reservation |
| MERGE-1, NEW-MERGE-1 | `addWinsSet` uses (local ∩ remote) ∪ (local − base) ∪ (remote − base). `buildLocalDiff` includes only fields whose local value differs from base. | W7 |
| Server materialization of arrays | Use the same corrected set formula in `replayOperationsForRecord`, so new two-device edits stop diverging between client and server. | W7 |
| NEW-STORE-7 *(LMS)* | Before every OPFS open, call `reserveMinimumCapacity(currentFiles + 2 + headroom)`. This stops a 6th per-user database from bricking every user on a shared device. | W8a file manifest |
| NEW-STORE-6 *(LMS)* | When `promoteToLeader` or `open` ends up non-durable, emit a blocking `store:durability-lost` event and refuse writes, instead of silently running in memory. | W8a policy |

### W1. Server trust boundary (Phase 1), P0

**Root cause:** authorization reads attacker-controlled op fields and the session state machine is not enforced.

| Step | Fixes | Change | Files |
|---|---|---|---|
| 1 | SEC-1 | Handshake gate: `handleMessageAsync` rejects every non-`handshake` message unless state is `syncing` or `streaming`; reply `HANDSHAKE_REQUIRED` and close. `operationAllowedFromClient` fails closed when auth is configured and `authContext` is null. | `server/src/session/client-session.ts:638-645, 1340-1346` |
| 2 | SEC-2, SEC-6, NEW-SEC-1 | One shared `authorizeUplinkWrite(op, storedRow, scopes)` used by sync uploads, `request.kora` routes, and the store-conditional path. It always loads the stored row (including deleted) and requires the stored row in scope (if it exists) **and** the post-image in scope. It never reads `previousData`. The check runs **inside the store's apply transaction** against a locked row (`SELECT ... FOR UPDATE` on Postgres, the single writer lock on SQLite), so it cannot race an ownership change or a same-id insert on another instance *(review)*. Routes: push scope predicates into the query so `limit` applies after scoping; replace `recordMatchesScope` with the shared `matchesPredicate` (adds `$in`). | `server/src/scopes/server-scope-filter.ts`, `server/src/server/route-context.ts:145-158, 250, 344, 449, 598`, store apply paths |
| 3 | SEC-3 (server) | Bind nodeId to principal: reject ops where `op.nodeId !== session.clientNodeId` or `op.timestamp.nodeId !== op.nodeId` (`NODE_ID_MISMATCH`, non-retriable). Add `ServerStore.claimNode(nodeId, userId)` at handshake under auth. The client must upload only its own ops for this to be safe (W3 step 1b), and must flush or explicitly hand over unsynced ops before a sign-in change assigns a new nodeId *(review)*. Ship the client change in the same release. | `client-session.ts:724, 943`, all three server stores, `sync-engine.ts:1349-1361` |
| 4 | SEC-4 | Handshake response carries only vector entries for nodes the client already reported plus its own; reject path sends `{}`. | `client-session.ts:858, 876` |
| 5 | SEC-5 | Side channels: register sessions with the yjs, awareness and blob relays only once streaming. Yjs updates are write-checked with step 2 and delivered only to sessions whose downlink scope contains the stored record. Awareness binds clientId to session and partitions by scope. Blob: auth required, `pending` capped per session with TTL, push limited by bytes and quota and accepted only for hashes referenced by the session's ops. Set WebSocket `maxPayload`. | `server/src/server/kora-sync-server.ts:704-705, 866-876`, `richtext/yjs-doc-relay.ts`, `awareness-relay.ts`, `blob-chunk-relay.ts:124` |
| 6 | SEC-8 | Stop putting the token in the WebSocket URL; the handshake already carries it. Opt-in `tokenInUrl` for proxies that need it. | `sync/src/transport/websocket-transport.ts:114-117`, `docs/api/sync.md:269` |
| 7 | SEC-9a | `trustProxy` config (hop count or CIDR list); default to the socket address. | `server/src/server/production-server.ts:320-326` |

**Tests to green:**
- `server/tests/repro/`: SEC-1, SEC-2, SEC-4, SEC-5, SEC-6, SEC-9 (part a), NEW-SEC-1.
- `test/tests/repro/SEC-3.test.ts` (server half).
- `sync/tests/repro/SEC-8.test.ts`.

**Risk:**
- Step 2 adds one indexed row read per uploaded op. Benchmark it; it is acceptable.
- Step 2 forbids client-side ownership transfer (decision D5).
- Step 3 breaks setups where one local store is shared across sign-ins; give each user a fresh nodeId on sign-in change.

### W2. Auth: scopes and credential lifecycle (Phase 1), P0

**Root cause:** the server treats the client-declared scope as an authorization grant, and revocation is a per-check flag rather than a single enforced primitive.

| Step | Fixes | Change |
|---|---|---|
| 1 | AUTH-1 | `toSyncAuthProvider()` and `createKoraAuthServer({ resolveScopes })` return **server-derived** scopes. The default derives `userId` from verified `sub`, and `resolveScopes(claims)` supplies any other binding (orgId, teamId).<br>**Fail closed** *(review)*: `buildScopeMap` today silently omits a binding whose key is unresolved, which yields `{}`, and the server treats `{}` as "fully visible". For a scoped collection, any unresolved binding must deny with `SCOPE_REQUIRED` rather than produce an empty scope.<br>`resolveSessionScopes` becomes an intersection: the collection set is `keys(authScopes)`, and the handshake can only narrow. For an `$in` grant, a handshake value must be a subset of the granted values.<br>An authenticated provider with no scopes on a schema with scoped collections is denied, not warned.<br>`MixedAuthProvider`'s anonymous set equals `keys(anonymousScopes)`.<br>Invariant: effective scope ⊆ server grant, and no scoped collection ever resolves to `{}` for an authenticated principal. |
| 2 | AUTH-2, AUTH-8, AUTH-7b, AUTH-14 (admin revoke) | One `authenticateAccess(token)` used by every HTTP route and `requireAuthUser`. It checks signature, expiry, jti revocation, device revocation and per-user `tokensValidAfter`. Refresh checks device revocation. Add `revokeAllForUser(userId)` and call it from password reset, password change, admin session revoke and user delete. |
| 3 | AUTH-5, NEW-AUTH-1, NEW-AUTH-3 *(LMS)* | **Rotation-safe refresh** (NEW-AUTH-3): if the server rotated the refresh token but the response was lost, a retry with the old token is accepted once, within a short grace window (about 30s), and returns the same successor pair. Today that retry trips reuse detection and signs the user out, which is common on 2G. Device ids are owned: `registerDevice` throws on a cross-user id. Default device id is random per install, not `device-${userId}`. Replace the permanent `revokedDevices` set with `revokedBefore[deviceId]`, so a fresh primary sign-in recovers. Reuse detection revokes the **token family** (`familyId` claim), not the device. |
| 4 | AUTH-6, AUTH-12 | Add atomic `consume(jti, exp)` to `TokenRevocationStore`. Ship SQLite and Postgres revocation stores. In production, `createKoraAuthServer` refuses in-memory user or revocation stores unless `allowInMemory: true`. |
| 5 | AUTH-11 | Store token `exp` in `AuthContext` and close the session with retriable `AUTH_EXPIRED` at expiry. Add `KoraSyncServer.terminateSessions({userId, deviceId})`; `createKoraAuthServer().bindSyncServer(server)` wires revoke, sign-out and reset to it. Client refreshes and re-handshakes on `AUTH_EXPIRED`. |
| 6 | AUTH-13, NEW-AUTH-2, NEW-AUTH-4 *(LMS-upgraded)* | **Only the server can end a session.**<br>• **Definitive failures:** clear tokens only on a 401, or a 400 `invalid_grant`, that carries a Kora JSON error code. Proxies and captive portals also send 401/403/407 or 200 HTML.<br>• **Transient failures:** everything else (no network, abort, timeout, 5xx, 429 with `Retry-After`, non-JSON 200, 511). These keep the tokens and retry with jittered backoff.<br>• **Timeout:** every auth request gets a timeout; today there is none, so a refresh can hang forever on 2G.<br>• **Single refresher:** a Web Locks cross-tab lock, plus a storage re-read after acquiring it, so only one tab refreshes and the others adopt its result (NEW-AUTH-2).<br>• **New state:** an explicit `authenticated-offline` state. The stored identity (user id, device id) is decoupled from token freshness, and the sync binding and `namespaceByAuthUser` use that stored identity. That way the user's own database opens offline and `AuthBoundKoraProvider` does not show the signed-out screen.<br>• **Grace period:** an optional `maxOfflineGraceMs`. When it expires, lock the UI but never wipe local data.<br>• **Clock safety:** guard against a device clock that has been set back.<br>• **restoreSession:** treat a 401 from `/auth/me` as definitive, not as "offline" (NEW-AUTH-4). |
| 7 | AUTH-3 | OAuth state bound to purpose, user (for link) and a client binding (HttpOnly cookie on web, in-memory for native PKCE). Separate authenticated `/oauth/:p/link/start`. Never take `deviceId` from state metadata. |
| 8 | AUTH-4 | `listMyInvitations(userId)` resolves the verified email server-side and strips tokens. Accept requires a verified email match. `revokeInvitation(orgId, id)` is org-scoped. |
| 9 | AUTH-7a, AUTH-9 | Throw at construction in production if no `onResetRequested`. Constant-time sign-in via a dummy hash. Two-key rate limit (`email`, `ip`) using the W1 step 7 client IP. |
| 10 | AUTH-10 | MFA users get `{mfaRequired, mfaToken}` (type `mfa_pending`, rejected everywhere else). `/auth/mfa/verify` issues real tokens with `amr`. Per-user TOTP failure backoff. `consumeCode` in disable and recovery regeneration. |
| 11 | AUTH-14 | Passkey user-verification flag enforced. `ExternalJwtProvider` requires `exp` and checks `aud`/`iss` when configured (default `aud: 'authenticated'` for Supabase). Webhooks: signed timestamp with tolerance, https only, deny private and link-local targets at delivery. `AdminApi` takes an `isAdmin` predicate. |

**Tests to green:** `auth/tests/repro/` AUTH-1 to AUTH-14 and NEW-AUTH-1 (27 tests).

**Order inside W2:** 1, 6, 3, 2, 5, 4, then 7 to 11. Step 1 is the P0. Step 6 is the most user-visible offline bug. Steps 3 and 2 stop lockouts and revocation bypass.

**Risk:**
- Step 1 is the biggest breaking change in the plan. Apps that relied on client-only scopes get empty or denied sync until they configure `resolveScopes`; ship a migration guide and a startup error that names the fix.
- Step 5 increases reconnects at token expiry.

**Strategic note (unchanged from the dossier):** while fixing, design the step 1 and 2 interfaces so an external OIDC token can be exchanged for a Kora device credential. Long term, Kora should own device identity and sync authorization, and delegate passwords, OAuth, MFA and passkeys.

### W3. Upstream contiguous acknowledged prefix (Phase 2), P0

**Root cause:** "is my op on the server?" is answered by `max(seq)` from acks or from the server's vector, so any gap below the max is forgotten.

**Design:**

*Revised after review: the first draft had the server enforce `seq == vector + 1`. That would stall uploads permanently in three common cases: (1) rejected ops, which never advance the server vector; (2) local-only collections, whose ops consume sequence numbers but are never uploaded; (3) several tabs sharing one nodeId. Contiguity is therefore tracked on the client, where all three cases are knowable.*

1. **Fix the upload selection.**
   - (a) Split the direction-agnostic predicate. `operationAllowedForUpload(op)` checks the uplink scope only, never query subsets (fixes SYNC-1, shipped early in S1). `operationAllowedForDownload` is covered in W4.
   - (b) `collectDelta` uploads only ops with `nodeId === self`. Today it walks every node in the local vector and would re-upload relayed ops, which W1's `NODE_ID_MISMATCH` would then reject.
2. **Client-side contiguous prefix.** The client keeps `localAckedThrough`: the highest seq s such that every local op ≤ s is in one of these states:
   - server-acked;
   - terminally rejected and recorded;
   - **not upload-eligible**: a local-only collection, or out of uplink scope at creation time and recorded as such.

   It is persisted in place of the max-merged acked vector.
   - `reconcileOutboundFromOpLog` enqueues every eligible local op above it.
   - The server-advertised vector **never** advances the client's own entry (the SEC-3 client half).
3. **Correlate acks with batches.** Track every sent batch, delta and streaming, in `Map<messageId, ops>`.
   - An ack resolves only its batch, and retriable rejections return ops to the queue.
   - Remove the non-strict early dequeue at `sync-engine.ts:1786-1797` (fixes SYNC-4).
4. **Server-side duplicate safety instead of strict ordering.** The server rejects a second, different op id for an existing `(nodeId, sequenceNumber)` (`SEQUENCE_CONFLICT`, non-retriable). Clock rebase (`maybeRebaseQueuedOperations`, `sync-engine.ts:1224-1251`) only re-stamps ops that have **never been sent**: track a `sentAt` flag per op. Today it re-stamps everything queued, which under W3 could include ops the server already stored but whose ack was lost; with atomic increments that would double-apply.
5. **Multi-tab.** Only the storage-leader tab runs the upload loop. Other tabs hand their ops to it through the store; the sequence is shared and the leader uploads in order. This fixes STORE-10's shared-nodeId interleaving at the root. It depends on W6 step 5.
6. **Upgrade recovery.** On the first handshake after upgrading, the client sets `localAckedThrough = 0` and re-uploads its own eligible ops in chunks. The server dedups by id, so this is idempotent. Ops that beta.12 silently lost (SYNC-1, SYNC-4, SEC-3) are **recovered**, not just prevented from now on. It is a one-time upload of the device's own history; a resumable cursor keeps it cheap on bad networks.
7. `OutboundQueue.acknowledge` removes ids from `seen` (fixes SYNC-6).

**Files:**
- `sync/src/engine/sync-engine.ts:529-532, 1157, 1224-1251, 1274, 1336-1362, 1584-1609, 1786-1797, 1828-1837, 1865-1871, 2064-2092`
- `sync/src/engine/outbound-queue.ts:86-93`
- server stores (step 4)
- `store/src/multi-tab/tab-storage.ts` (step 5)

**Tests to green:** `kora/tests/repro/SYNC-1`, `test/tests/repro/SYNC-4`, `sync/tests/repro/SYNC-6`, `test/tests/repro/SEC-3` (client half). Invert `sync-engine.test.ts:2038`.

**Risk:** medium.
- Users with query subsets upload more, which is correct.
- Handshake completion timing changes. Covered by the convergence gate.

### W4. Downstream: never skip silently (Phase 2), P1

**Root cause:** the watermark advances on outcomes that are not durable, and visibility is judged per op instead of per record.

| Step | Fixes | Change |
|---|---|---|
| 1 | SYNC-2 | Inbound delivery batches are not filtered by uplink scope. Apply what the server delivered (it already enforced the downlink scope); if the client deliberately drops an op, it must quarantine it. |
| 2 | SYNC-3, SYNC-7, ENC-2 | Add a durable inbound quarantine `_kora_unapplied_ops (op, delivery_seq, reason)`.<br>• Ops that go to quarantine, with a `sync:apply-failed` event: unknown collection or schema, transform-to-null, deferred, far-future timestamp, and decrypt failure.<br>• The quarantine row and the watermark advance are written **in the same transaction** *(review)*.<br>• Replay the quarantine on schema upgrade and on start.<br>• **Far-future timestamps are stopped at the server** *(review)*: every ingest path (sync, route `kora.apply`, backup import) validates timestamps against server time. The client quarantines rather than applies anything that still arrives; applying it would make local edits lose to it until real time caught up.<br>• Restrict-rejected remote deletes are appended to the op log, and the server applies the same restrict rule.<br>Invariant: watermark ≤ min delivery seq of any op neither applied nor quarantined. |
| 3 | NEW-SYNC-1, SYNC-11 | The duplicate branch still runs initial-sync bookkeeping (`isFinal` completes the handshake). A batch straddling the watermark is applied (idempotent) and advances to its max. The handshake sends the last **accepted** downlink scope; when the server's accepted scope differs, call `switchDeliveryView`. |
| 4 | SRV-2, NEW-SRV-3 | Scope entry detection on the server: when an op makes a record newly visible to a client (judged from server replay of the prior state, not `previousData`), first send every earlier op of that record. Invariant: a client holding any op of R holds every lower-sequence op of R. Exits are also computed from server state. |
| 5 | SRV-3 | Add `lastSentDeliverySeq`; live pushes chain from it and rewind to `lastAcked` only on retransmit timeout or a reported gap. |
| 6 | SRV-5 | Stream per scan chunk (O(chunk) memory per client) with one-batch lookahead for `isFinal`. Memory store seeks by binary search. |

**Files:** `sync/src/engine/sync-engine.ts:1181-1183, 1365-1531`; new quarantine table in store; `server/src/session/client-session.ts:417-466, 817-822, 1204-1247, 1319-1337`; `server/src/scopes/server-scope-filter.ts:89-146`.

**Tests to green:**
- `kora/tests/repro/`: SYNC-2, SYNC-11.
- `test/tests/repro/`: SYNC-3, SYNC-7, SRV-2, SRV-3.
- `sync/tests/repro/NEW-SYNC-1`.
- `server/tests/repro/SRV-5`.
- `kora/tests/repro/ENC-2` (quarantine part).

**Risk:** medium. The quarantine replay order must respect HLC order; step 4 adds burst sends on reassignment.

### W5. Connection lifecycle (Phase 2), P1/P2

| Step | Fixes | Change |
|---|---|---|
| 1 | SYNC-5 | Any engine-initiated move to `disconnected` calls `transport.disconnect()`. `WebSocketTransport.connect` closes and detaches the previous socket. Handlers are bound to a socket generation, so stale callbacks are ignored. |
| 2 | SYNC-8, NEW-SYNC-2 | Reconnect "success" means reaching `streaming`, not handshake sent. The attempt counter persists across manager runs and resets only after N seconds of streaming. A disconnect while starting sets a `pendingRetry` flag. `reset()` no longer clears `stopped`. |
| 3 | SYNC-10 | `stopInternal` clears every timer before any early return. Add `destroy()` for `app.close()`. The encrypt-then-send continuation checks the batch is still current and catches send errors. |
| 4 | SRV-6 (liveness) | Handshake deadline (close if no handshake within 10s), WebSocket ping/pong heartbeat, `bufferedAmount` backpressure, idle expiry of HTTP sessions, and a server-issued session secret required on every HTTP poll (replaces `clientId` as a bearer). |

**Tests to green:**
- `kora/tests/repro/`: SYNC-5, SYNC-8, SYNC-10, NEW-SYNC-2.
- `server/tests/repro/SRV-6`: the HTTP expiry facet.

**Risk:** low.

### W6. One local write path (Phase 2), P0

**Root cause:** `TransactionContext` is a second, weaker implementation of insert/update/delete, and the public `app.transaction` commit (`ApplyPipeline.commitTransaction`) never persists the sequence counter.

**Design:** buffered transaction entries are executed at commit, inside the commit's database transaction, through the **same** builders as single-record writes (`executeInsert` / `executeUpdate` / `executeDelete`, with an injected `tx`).

That one change brings:
- In-transaction sequence reservation: one `UPSERT ... RETURNING` reserving a contiguous block that also covers cascade side effects (STORE-1, STORE-2).
- Per-field version stamps (STORE-3).
- Secret transformation (STORE-4).
- State machine validation (NEW-STORE-2).
- Atomic ops resolved against a row read inside the transaction (STORE-9).

**Additional steps:**
1. Delete `TransactionSequenceAllocator`. Never `INSERT OR REPLACE` the version vector with an out-of-transaction value; use `MAX(existing, new)`. **Ops are built only after their sequence block is reserved; never re-stamp a built op.** Protocol v2 includes the sequence in the op id hash, so re-stamping would change ids *(review)*.
2. **Uniqueness without a contradictory migration** *(review)*. A plain `UNIQUE(node_id, sequence_number)` cannot be created while beta.12 duplicates exist. Instead:
   - (a) The repair migration moves every duplicate row except the first, by id order, into `_kora_seq_conflicts`, and re-emits each one's content as a **new** op with a fresh sequence (a new id, so server dedup cannot swallow it). The data survives; only the colliding identity is retired.
   - (b) Then create the unique index.
   - (c) The server, given a duplicate `(node, seq)` with a different id, answers `SEQUENCE_CONFLICT` (W3 step 4) rather than silently deduping.
3. `define.ts` derives the collection state machine from enum fields with `.transitions()` (NEW-STORE-3).
4. Adapter `execute`/`query` take the same mutex as transactions (STORE-8).
5. On a `'duplicate'` apply, still record the sequence and notify subscriptions, and broadcast remote applies on the local operation bus (STORE-10).
6. Lows (STORE-15): dedup via `INSERT OR IGNORE` inside the transaction; in-memory vector updated after commit; collision-free index names; map `SQLITE_FULL` and OPFS quota errors to `store:quota-exceeded`.

**Files:**
- `store/src/transaction/transaction-context.ts:161-432`
- `store/src/transaction/transaction-sequence.ts`
- `kora/src/apply-pipeline.ts:150-219`
- `kora/src/build-side-effect-entry.ts:29, 66-69`
- `store/src/mutations/execute-update.ts:31-114`
- `store/src/relations/relation-enforcer.ts:187`
- `core/src/schema/sql-gen.ts:117`
- `core/src/schema/define.ts:285-291`
- adapters
- `store/src/store/store.ts:285-308, 535-541`

**Tests to green:**
- `kora/tests/repro/`: STORE-1, 2, 3, 4, 9, NEW-STORE-2, NEW-STORE-3.
- `store/tests/repro/`: STORE-8, 10, 15.

**Risk:** medium. The repair migration on existing user databases is the delicate part; test it on databases produced by beta.12.

### W7. One deterministic fold, everywhere (Phase 3), P0

**Root cause:** a record's state is computed three ways:
- per-field LWW in the client store;
- pairwise three-way merges in `apply-pipeline.ts` for arrays, objects, resolvers and constraints;
- a whole-value LWW log replay on the server.

The pairwise merge runs on rows that already contain earlier merges, picks fast-forward or merge based on unrelated local state, marks untouched fields as changed, and stamps the whole row with one timestamp. Verified: permanent divergence between clients (5/12 seeds for arrays, 1/12 for objects), and in two-device scenarios (NEW-MERGE-1).

**Design (decision D3a, revised after review):**
1. **Per-field merge state that is itself a CRDT.** The record keeps per-field metadata, so merging an op is a commutative, associative, idempotent `mergeOp(state, op)`. The result is independent of arrival order, needs no replay, and survives compaction and very late offline ops. The code lives in `@korajs/core` and is used by the client store, every server store, backup restore, studio and replay. Per kind:
   - **Scalars:** LWW register (value plus HLC). This is today's `_field_versions`, made exact per field.
   - **Arrays:** LWW element set. Each element carries `(addedAt, removedAt)` HLCs taken from ops that add it (`data − previousData`) or remove it (`previousData − data`); it is present iff `addedAt > removedAt`. Removal markers are kept, and the order is by first `addedAt`. This fixes MERGE-1 for good.
   - **Objects/json:** a per-top-level-key LWW register with removal markers. Nested values are whole-value LWW per key; the docs state that depth explicitly.
   - **Atomic ops:** the existing chain fold. This needs the field's op log, so atomic fields keep their log (see step 6).
   - **Custom resolvers:** applied to ops in HLC order; `local` now means the current merged state. That is a documented semantic change. Commutativity is not required under a fixed total order, but these fields keep their log.
   - **Richtext:** Yjs (already a CRDT).
   - **Insert onto an existing row:** merged per field, not a reset.
2. **Exclude what the server refused.** The client merge excludes ops the server terminally rejected, and re-merges the record when a rejection arrives. Today the author keeps folding an op the server never stored *(review)*.
3. **Side effects and constraints get one authority** *(review)*. Today every replica that applies an op emits its own cascade and constraint side-effect ops, which under a fold would multiply and race.
   - Side-effect ops get **deterministic ids** derived from `(parentOpId, ruleId, targetRecordId)`. Replicas that generate the same effect produce the same op, which dedups everywhere. This keeps cascades working offline.
   - Tier-2 constraints that depend on **other** records (unique, capacity, referential restrict) are evaluated optimistically on clients and authoritatively on the server. Corrections from the server arrive as ordinary ops. Within-record rules (state machines) stay in the per-record merge.
4. **Client apply becomes "append, then merge"** for the affected record. Remove `applyMergedUpdate`, `buildLocalDiff`, `resolveLocalTimestamp` and the fast-forward/merge split from `apply-pipeline.ts`. MergeTrace is emitted from `mergeOp`, so DevTools keeps per-field explanations.
5. **Protocol v2 (decision D2).**
   - Ops gain a `hashVersion` field *(review)*. v2 ids hash previousData, sequenceNumber, causalDeps and schemaVersion as well (CORE-1).
   - Verification points:
     - The **server** verifies v2 ids only on plaintext ops, and **before** any schema transform, since today's `transformForServerSchema` rewrites op data.
     - **Clients** verify after decryption.
     - v1 ops already stored keep `hashVersion: 1` and are never verified against v2 rules.
   - W3's `SEQUENCE_CONFLICT` rule.
   - Encryption envelope v2 (W9).
   - v1 clients are accepted for one release with a deprecation warning.
6. **Compaction becomes safe (STORE-14).** The per-field metadata is the snapshot, so ops whose effect is fully captured in it can be compacted.
   - Atomic and resolver fields keep their op log.
   - Delete markers are kept.
   - Dedup of compacted ids relies on the per-node acked prefix from W3, not on keeping every id.
7. **Re-materialization migration.** Runs after W8's log-integrity scan, so it never rebuilds from a corrupted log. Client and server rebuild per-field state from the op log. This also repairs every replica that diverged under beta.12.
8. **Incremental cost (SRV-7)** falls out of step 1: each write is O(fields touched), not O(record history). Atomic and resolver fields fold from their last checkpoint.

**Files:**
- New `core/src/fold/*`
- `core/src/operations/replay-record.ts` (replaced)
- `core/src/operations/content-hash.ts`
- `kora/src/apply-pipeline.ts` (large reduction)
- `merge/src/engine/*` (pairwise engine stays only for traces and constraints)
- `merge/src/strategies/add-wins-set.ts` (retired or reimplemented as an op delta)
- `server/src/store/*-server-store.ts` (materialization)
- `store/src/compaction/*`

**Tests to green:**
- `test/tests/repro/`: MERGE-1, MERGE-2, NEW-MERGE-1, SRV-1, CORE-1.
- `core/tests/repro/CORE-1`.
- `server/tests/repro/SRV-7`.
- `kora/tests/repro/STORE-14`.
- The W0 convergence gate at 200 seeds across every field kind.

**Risk:** high, by design; this is the heart of the framework.
- Mitigation 1: the property gate is written before the merge code.
- Mitigation 2: `mergeOp` is pure, with its own property tests for commutativity, associativity and idempotency per kind.
- Mitigation 3: the migration is tested on beta.12 databases.
- Mitigation 4: the old pipeline runs behind a flag for one beta to compare outputs in CI.

**Effort:** 25 to 35 days. It includes the protocol v2 window, the client and three server-store migrations, side-effect id derivation, and the comparison harness.

### W8. Durability edges (Phase 3), P0/P1

| Step | Fixes | Change |
|---|---|---|
| 0 | prerequisite for W7 *(review)* | **Log-integrity scan.** On open, and in the server migration, detect op rows that do not round-trip through `deserializeOperation` (for example a null `wallTime` from beta.12 restores) and gaps left by compaction. Repair the timestamp when the original is recoverable from the row's JSON; otherwise quarantine the row and emit an event. W7's re-materialization runs only on a clean log. |
| 1 | STORE-5 | Backup exports canonical `Operation` JSON including tombstones, and imports through `serializeOperation`. Merge mode never imports `node_id` or sync meta; version vector via `MAX`; ideally replay through `applyRemoteOperation` and the W7 fold. Replace mode then calls `Store.reloadFromDisk()` (node id, vector, sequence, `clock.receive(maxTs)`) and invalidates all subscriptions. Bump `BACKUP_VERSION` and reject old-format files with a clear error plus a converter. |
| 2 | STORE-6 | Only the storage leader restores an IndexedDB snapshot (expose `inner.isLeader()`). On promotion, restore only into a freshly created worker DB. Restore runs in one transaction. |
| 3 | STORE-7 | The persistence scheduler gets a dirty flag; `flushNow` loops until clean. The dump is taken inside one read transaction (no torn snapshots). |
| 4 | STORE-13, NEW-STORE-1 | Each schema version's DDL, backfills and `schema_version` write run in one transaction. Backfill transforms receive deserialized records. Backfills emit ops (with `mutationName: 'migration:vN'`) so they sync, or are explicitly declared `localOnly`. |

**Tests to green:**
- `kora/tests/repro/`: STORE-5, STORE-13, NEW-STORE-1.
- `store/tests/repro/`: STORE-6, STORE-7.

**Risk:**
- Step 1 changes the backup format.
- Step 2 needs a real browser test (add a Playwright case: two tabs, IndexedDB fallback, leader writes, follower opens).

### W9. Encryption that works (Phase 4, envelope ships in Phase 3's protocol v2), P1

1. **ENC-1.** Shared key material (decision D4b): a server-stored, passphrase-wrapped data key, fetched at sign-in and cached locally. Stopgap: a deterministic salt from `appId + userId` behind a flag. Persist the salt and key id locally, and include the key id in the envelope so mismatches are diagnosable. Fix `sync-encryption.md:83, 222`, which currently promise behavior that does not exist.
2. **NEW-ENC-1.** Move ciphertext out of `data` into `op.encrypted` (with `data: null` and documented cleartext scope fields), or teach `validateOperationShape` to recognize the envelope. Either way, a schema-aware server must store encrypted ops opaquely.
3. **ENC-3.** AES-GCM AAD = canonical(nodeId, collection, recordId, type, timestamp, sequenceNumber, field, keyVersion). Verify the op id over the decrypted plaintext (W7). Reject plaintext when encryption is enabled unless an explicit `allowPlaintextMigration` window is set.
4. **ENC-2.** Per-op decrypt inside the apply path, with failures going to the W4 quarantine.

**Tests to green:**
- `kora/tests/repro/`: ENC-1, ENC-2, NEW-ENC-1.
- `sync/tests/repro/ENC-3`.

**Risk:** the wire format breaks, but today's encrypted data cannot be read across devices anyway, so there is nothing to preserve.

### W10. Server scale and limits (step 1 moves to Phase 2; the rest is Phase 4), P1/P2

1. **SRV-4 (Phase 2, because W1's `claimNode` and W3 depend on it).**
   - Postgres `getVersionVector()` reads `sync_state` (no per-process cache).
   - Dedup via `INSERT ... ON CONFLICT DO NOTHING RETURNING` inside the transaction, taking the delivery seq only after a successful insert (also fixes NEW-SRV-2, the double cascade).
   - Migrate `sequence_number` and `max_sequence_number` to `BIGINT`.
   - Validate `sequenceNumber` as a safe positive integer at ingest.
2. **SRV-6 (limits).**
   - Rate limiter keyed by authenticated user or node in a server-level map with TTL, called before the scope check, and counting rejections.
   - Ops-per-batch cap (default 1000).
   - `readBodyBuffer` cap (default 1 MiB, then 413 and destroy).
   - Explicit WebSocket `maxPayload`.
   - A sane default `maxConnections`.
3. **NEW-SRV-1.** The memory store rebuilds from the record's ops only (it is test-only, but the tests matter).
4. **Cross-instance fan-out.** Replace the 2-second delivery poll with Postgres `LISTEN/NOTIFY` on commit. This is not one of the 86 problems but is the natural follow-on once the vector reads from the database; mark it optional for this plan.

**Tests to green:** `server/tests/repro/SRV-4` (with `KORA_PG_TEST_URL`; add a Postgres service to CI) and `SRV-6`.

### W11. Types that actually check (Phase 4), P1

1. **DX-1.** Give `FieldBuilder` structural brands (`declare readonly __req: Req; declare readonly __auto: Auto`). This is type-only, with no runtime cost. Optional and defaulted fields then infer as `T | null` where appropriate, and insert inputs become required, optional or forbidden correctly.
2. **DX-2.**
   - `where` as `Partial<{[K in keyof R]: R[K] | Operators<R[K]>}>`.
   - `orderBy` as `keyof R & string` (including the virtual `createdAt`/`updatedAt` from W12).
   - `include` returns `T & { relation: Target | null }`.
   - Typed transaction proxy.
   - `createKoraHooks<typeof app>()` for typed `useCollection`.
   - `ObjectFieldBuilder<F>` and `ArrayFieldBuilder<B>` carry inner types.
   - `default(value: InferFieldType<this>)`.
3. Switch the flagship template to the typed path so new users see inference working.

**Tests to green:** `kora/tests/repro/types/DX-1.ts` and `DX-2.ts` under `tsc --noEmit` in CI, plus the rewritten `infer.test.ts`.

**Risk:** stricter types break user code that compiled by accident; this is intended. Call it out in release notes.

### W12. DX, docs, hooks and hygiene (Phase 4), P2/P3

| Fixes | Change |
|---|---|
| DX-3 | Fix `getting-started.md:242-247`, the `useRichText` signature in `docs/api/react.md:389-422`, the "no loading state" claim, the "one line" sync claim (or default `autoConnect` to true when `sync.url` is set; recommended), and the README version. Add a CI step that extracts and typechecks doc code blocks. |
| DX-4 | `findById` before ready throws `AppNotReadyError` like every other method. |
| DX-5 | Stable `subscribe`/`getSnapshot` and memoized callbacks in `useMutation`, `useSyncStatus` and `useRichText`; add a StrictMode test for `useMutation`. |
| DX-6, NEW-DX-1 | `getServerSnapshot` in `useQuery` and `useCollaborators`. SSR-safe `createApp` (no adapter opened when `typeof window === 'undefined'` unless `ssr: false`). Add a Next.js App Router guide. |
| DX-7 | Vue `useQuery` accepts `MaybeRefOrGetter` for the query and `enabled`. Check Svelte for the same issue. |
| DX-8 | Label Render and Docker "coming soon" and refuse them up front, or ship a Docker "artifacts only" adapter. |
| DX-9 | Dev-mode warning when a collection name is shadowed by a reserved app property. |
| STORE-11 | Map `createdAt`/`updatedAt` to `_created_at`/`_updated_at` in where and orderBy. |
| STORE-12 | Structural equality per field kind in the subscription diff; error channel to subscribers (`query:error` and `useQuery` error state); `.catch` in `registerAndFetch`. |
| SEC-7 | Whitelist the sort direction; bind `limit`/`offset` as parameters after a safe-integer check. |
| SEC-9b | Escape quotes in `sqlDefaultLiteral` and enum CHECKs. |
| SYNC-9, NEW-DX-2 | Stop advertising protobuf until per-session serializers exist and every message type round-trips (add a property test); delete `DynamicProtobufSerializer` or wire it. |
| STORE-16 | Rename the "SQLite WASM" gate honestly, add a Playwright browser benchmark (real worker and OPFS), time IndexedDB persistence, and add a 1,000-subscription fan-out gate. |

**Tests to green:**
- `kora/tests/repro/`: DX-3, DX-4, DX-9, STORE-11.
- `react/tests/repro/`: DX-5, DX-6.
- `vue/tests/repro/DX-7`.
- `cli/tests/repro/DX-8`.
- `store/tests/repro/`: STORE-12, SEC-7.
- `server/tests/repro/SEC-9` (part b).
- `sync/tests/repro/SYNC-9`.

---

## 5. Definition of done (per phase and overall)

A phase is done when all of these hold:
1. Every repro test assigned to it passes as a normal (non-`fails`) test.
2. The tests that encoded bugs are inverted.
3. The convergence gate and the hostile-client suite pass.
4. `pnpm test:pre-release` (including e2e) is green.
5. The docs for every behavior change are updated.
6. Release notes list each breaking change with a migration step.

**Overall done when:**
- All failing repro tests pass: the 144 from the first review, the 46 Node and 14 browser checks from the LMS intake, and the offline-reload check.
- A scaffolded app reopens offline from a cold start in real Chromium (NEW-DX-3), and a shared tablet with 10 per-user databases keeps every user's data durable (NEW-STORE-7).
- The convergence gate passes 200 seeds over every field kind with drops, duplicates and reordering.
- The hostile-client suite cannot read or write across tenants on any channel (ops, routes, yjs, presence, blobs).
- A beta.12 database (client and server) upgrades through the migrations and converges.

---

## 6. Open items not yet verified

- `app.sync.waitForSettled({ timeoutMs })` was observed resolving about 5s late, and once never resolving, in two verification runs. It was outside every reviewer's scope and is **not** in the 106. Verify it before Phase 2 closes, since status accuracy is part of "no silent loss".
- STORE-6 was confirmed with a faithful Node simulation (fake-indexeddb plus a bridge modeled on the real worker), not in a real browser. W8 step 2 adds the browser test.

## 7. Corrections to the dossier

- "causalDeps is always [] for user operations" is wrong: user ops carry the previous local op in the same collection. They carry no cross-device causality, and only transaction ordering and replay tools read them.
- "Any update revives a deleted record server-side" is refuted: the client uses the same fold for that case.
- Store finding D7 understated the impact: the public transaction path also never persists the sequence counter.
- MERGE divergence is P0, not "suspected": it is reproduced between clients, not only between client and server.

## 8. Artifacts

- Reproduction test pack: 81 files, as a patch against 91c6350 (`kora-repro-tests.patch`), plus the six verification reports (`.verify/results-*.md`) with exact file:line, root cause, fix design and regression risk for every item.
- Run one: `cd <package> && npx vitest run tests/repro/<ID>.test.ts`.
- Postgres repro: set `KORA_PG_TEST_URL`.

---

## 9. External report intake: Bozoma Innovation Hub LMS team (2026-10-01)

The LMS team runs Kora beta.12 in production on low-cost Android phones in Ghana and sent 13 recommendations backed by roughly 600 lines of patches. Every claim, and every proposed patch, was treated as unproven:
- Four independent verifiers tested them: auth; store, in real Chromium with real OPFS, Web Locks and BroadcastChannel; sync scopes; and server, on real Postgres 16.
- I re-ran every resulting test twice, with identical results.
- One extra claim (the offline app shell) was verified separately in real Chromium.

### 9.1 Verdicts

Their field reports point at real pain. Their diagnoses were often wrong, and **none of their 13 patches meets the bar as written**:
- Two would create security holes (#3, #8).
- Three would lose or leak data (#6, #9, #11).
- One would stop the database opening after a sqlite upgrade (#13).
- Two do nothing at all (#2, #5).

| # | Their claim | Problem verdict | Their fix | Why | Where it lands |
|---|---|---|---|---|---|
| 1 | `performRefresh` destroys tokens on any error | **Confirmed** (= AUTH-13, P0) | Reject | It handles only network errors. 5xx, 429, timeouts and captive portals still sign out; it passed 3 of 14 test cases. There is no timeout or backoff, and it is not safe with token rotation. Downstream bindings still report signed-out. | W2 step 6 (upgraded) |
| 2 | `initialize()` wipes the session on offline cold start | **Confirmed** (= AUTH-13, P0) | Reject | It calls `this.isOnline()`, which does not exist, so the patch throws on exactly the offline path. `navigator.onLine` lies behind captive portals. The "store is gated by userId from the expired token" claim is false: the binding opens a `__user_signed-out` database. | W2 step 6 |
| 3 | localStorage is evicted independently of IndexedDB, so keep a dual-write backup | **Refuted.** Browsers evict an origin's storage all at once, and Safari's 7-day cap removes both. | Reject (security) | Their `clear()` keeps the IndexedDB copy, so after an offline sign-out the next start restores the previous user's session. That is account takeover on the shared tablets they describe. | Not adopted. Optional hardening: a single IndexedDB token store, encrypted with a non-extractable key bound to the device key. |
| 4 | Kora should call `navigator.storage.persist()` | **Partial.** Kora already calls it (`opfs-blob-store.ts:151-157`), but it awaits the result inside startup and discards it. On Firefox, which prompts the user, `app.ready` can hang (inferred; needs a manual Firefox check). `StorageSafetyGate` is their app code. | Reject as written | A framework must not trigger a permission prompt unprompted. | NEW-STORE-4 (W12) |
| 5 | OPFS install should retry on lock conflicts | **Partial, wrong cause.** Same-database tabs already elect a leader correctly. The real bug: the SAH pool is origin-wide (`kora-opfs`) while leader election is per database, so a second database (Kora's own `namespaceByAuthUser`, or a second Kora app on the origin) silently runs in memory, or in an IndexedDB fallback that shares no data with OPFS. | Reject | sqlite-wasm caches the failed install, so retrying in the same worker always fails (proven in the browser). Retry also cannot beat a live holder. | NEW-STORE-5, 6 (W8a) |
| 6 | Evict stale files when the "SAH pool is full" | **Partial.** The `kora-db-gN` generations are their app's naming. But pool exhaustion through Kora's own per-user databases is real and worse than reported: with the default 6 slots, the 6th user's database fails to open and **every existing user loses the ability to commit**. | Reject (data loss) | Their regex never matches sqlite-wasm 3.51's error. With the matcher widened, it deleted six other users' databases, each holding unsynced rows. | NEW-STORE-7, 8 (W8a) |
| 7 | Follower liveness probe should repeat (120s freeze) | **Partial.** The default timeout is 30s, not 120s. A dead leader is detected in about 21ms via lock release. The real gap is an alive but hung leader: in-flight requests wait about 27s, and there is no failover while it stays hung. | Accept with changes | Use one watchdog per bridge, cleared on settle, with request ids for dedup. A leader heartbeat plus release-on-freeze is the real fix. | NEW-STORE-9 (W8a) |
| 8 | Snapshot lacks `id`, so id-scoped data is dropped | **Partial.** Real data loss on the client inbound path only. It also exposed an **id forgery**: `previousData: {id: '<allowed>'}` lets a client update or delete any record under an id-scoped uplink. | Reject (security) | `if (!('id' in merged))` defers to the attacker's `id`. The correct rule sets `id = op.recordId` unconditionally, and the stored row is authoritative. | NEW-SEC-2 (W1 step 2), NEW-SYNC-3 (W4) |
| 9 | Skip client scope filtering when scopes are directional | **Partial.** The symptom is real, but the cause is SYNC-2 (inbound judged against the uplink scope), not incomplete snapshots. Separately: a fresh client loses an update delivered in the same batch as its insert, and the watermark moves past it. | Reject (privacy) | `hasDirectionalScopes` is true for **every** scoped session, so the patch disables the outbound uplink check for every scoped app. Local-only drafts then upload, get rejected, and are re-sent on every reconnect. | SYNC-2 (W4 step 1), NEW-SYNC-4 (W4) |
| 10 | Postgres backfill is slow; parallelise and batch | **Confirmed, worse than reported:** 40s and 60k statements at 100k ops, rerun on **every** restart. Also two correctness bugs: a rolling-deploy backfill overwrites live writes, and deleted records come back for scoped clients because tombstones lose their scope fields. | Accept with changes | Batching is the whole win (22-28x faster). Parallelism adds nothing on 2 cores and holds locks. A fixed batch of 500 breaks Postgres's 65,535-parameter limit on wide tables. | NEW-SRV-4, 5, 6 (W10) |
| 11 | Delivery stream does a query per op; preload all records | **Confirmed:** 12.4s and 39.8k statements at 100k ops (`retract` mode: 40.2s, 136k). Their 5+ minutes is plausible on a hosted database. | Reject | Preloading holds every tenant's rows in memory per connection, and loses updates to records created after the preload. "Skip retractions on first sync" is incorrect. | SRV-5 (W4 step 6), plus batched `id = ANY()` lookups (2.96s, 5.3k statements); NEW-SRV-7 |
| 12 | No WebSocket keepalive | **Confirmed, worse:** ghost sessions are rescanned on every poll, HTTP long-poll sessions are never freed, and clients have no heartbeat. | Accept with changes | `terminate()` does run Kora's close path (verified). It belongs in the transport, needs a configurable interval and 2 missed pongs, an app-level heartbeat for clients and HTTP, and must stop re-pushing stuck deliveries. | SRV-6 (W5 step 4) |
| 13 | No Cache-Control on hashed assets | **Confirmed, worse:** there is no Cache-Control, ETag, Last-Modified, 304 or compression; missing assets get `index.html` with a 200; `.webmanifest` gets the wrong content type. | Reject | `includes('/assets/')` would cache Kora's own **unhashed** `assets/sqlite3.wasm` for a year, so after a sqlite upgrade new JavaScript would load old WASM and the database would fail to open. | NEW-SRV-8 (W12) |

**Also found while verifying:** NEW-DX-3. No Kora template, CLI path or guide ships a service worker. Proven in real Chromium: an app served by `createProductionServer` loads online, then fails offline with `net::ERR_INTERNET_DISCONNECTED`. A Kora app's **data** works offline, but its **interface cannot open offline**. For an offline-first framework this is the single most visible gap.

**Already in the plan, independently re-confirmed by the intake:** AUTH-1 (the client can add collections to its own scope through the handshake), AUTH-2 (refresh ignores device revocation), AUTH-6 (refresh reuse race), SYNC-2, SRV-5, SRV-6.

### 9.2 The 20 new problems and their designs

| ID | Problem | Sev | Workstream and design |
|---|---|---|---|
| NEW-AUTH-2 | Two tabs refreshing at once sign out every tab | P1 | W2 step 6: Web Locks single refresher with a storage re-read |
| NEW-AUTH-3 | A rotated refresh response lost on the wire leads to reuse detection and sign-out | P1 | W2 step 3: one-time grace window returning the same successor pair |
| NEW-AUTH-4 | `restoreSession` treats a 401 from `/auth/me` as offline and stays authenticated | P2 | W2 step 6 |
| NEW-SEC-2 | `previousData.id` forgery bypasses id-scoped uplink checks (update and delete of any record) | P0 where id scopes are used | W1 step 2. One shared snapshot helper replaces the three copies: `id` comes from `recordId`, set last; reject ops whose `data` or `previousData` carry a system field that differs from it; the stored-row lookup is unconditional for scoped collections. |
| NEW-SYNC-3 | Inbound insert dropped on a client under an id-scoped downlink | P1 | W4 step 1 (no client-side inbound filtering of delivered ops) |
| NEW-SYNC-4 | A fresh client drops an update that arrives in the same batch as its insert, and the watermark advances | P1 | W4 step 1. Same fix, plus an invariant test: a batch is applied in order, never pre-filtered as a whole. |
| NEW-STORE-4 | `persist()` is awaited inside startup (can hang `app.ready`) and its result is discarded | P2 | W12. Add `app.storage.persistence.status()/request()` and a `storage:persistence` event. Check `persisted()` at boot (never prompts); request without awaiting after sign-in, the first write, or when running as an installed PWA. |
| NEW-STORE-5 | One origin-wide SAH pool vs per-database leader election: a second database silently gets non-durable or disjoint storage | P0 | W8a step 1 |
| NEW-STORE-6 | A promoted leader with no durable storage silently runs in memory | P0 | W8a step 2 (interim in S1) |
| NEW-STORE-7 | Pool capacity exhaustion with per-user databases bricks writes for every user on the origin | P0 (shared devices) | W8a step 3 (interim in S1) |
| NEW-STORE-8 | A failed open leaks the worker and leader lock, holding the pool for the page's lifetime | P1 | W8a step 3 |
| NEW-STORE-9 | A hung (alive, unresponsive) leader is not detected, and other tabs cannot take over | P2 | W8a step 4 |
| NEW-STORE-10 | `close()` releases the leader lock before terminating the worker that holds the pool (latent handoff race) | P2 | W8a step 2 |
| NEW-STORE-11 | `PRAGMA journal_mode=WAL` is a silent no-op on the SAH pool (mode stays `delete`); CLAUDE.md promises WAL | P3 | W12: correct the spec and docs; measure whether the journal mode matters on sahpool |
| NEW-SRV-4 | Postgres backfill reruns in full on every restart, with one statement per record | P2 | W10: parameter-limit-aware multi-row upserts, plus a persisted "materialized through" marker (invalidated by backup restore), so an unchanged start does nothing |
| NEW-SRV-5 | A backfill during a rolling deploy overwrites live writes from another instance | P1 | W10: per-row `_kora_seq` (highest op sequence folded) and `WHERE excluded._kora_seq > t._kora_seq` on upsert; no long lock-holding transactions |
| NEW-SRV-6 | Tombstones materialized without scope fields: scoped clients get the insert but never the delete, so the record comes back | P1 | W10: keep last field values on tombstones; W4 step 4's per-record visibility makes deletes follow their record |
| NEW-SRV-7 | `retract` mode looks up the stored record for every out-of-scope op, including inserts and deletes that can never exit scope | P2 | W4 step 6: check the op type first (removes about 70% of lookups), then batched lookups per chunk. Long term: scope keys stored on the op at write time, indexed (measured 36ms / 8 statements), designed together with the retraction rules. |
| NEW-SRV-8 | The static server sends no cache validators or compression, falls back to `index.html` for missing assets, and uses wrong MIME types | P2 | W12 (see below) |
| NEW-DX-3 | Scaffolded apps cannot open offline (no service worker or app-shell caching) | **P1**, framework promise | W12 (see below) |

### 9.3 W8a: OPFS ownership and durability (new, Phase 2)

Real-browser evidence showed that durable storage on the web is a protocol between tabs, workers and the pool. Kora treats it as a single open call.

1. **One owner per pool, by construction** (NEW-STORE-5).
   - The pool name is derived from the database name, giving one pool per database, so per-user databases never contend. The alternative, one origin-level pool owner multiplexing databases, is more complex; choose per-database pools.
   - The worker holds a Web Lock named after the pool for the pool's entire life.
   - A short bounded retry, using `forceReinitIfPreviouslyFailed`, covers only the ~90ms window while a closing worker releases its handles. Contention with a **live** holder is a wait-and-show-blocking-state condition, never a fallback.
2. **Durable or loud, never silent** (NEW-STORE-6, NEW-STORE-10).
   - Kora must never accept writes into a non-durable store without the app opting in.
   - `open()` and `promoteToLeader()` either return durable storage or raise `store:durability-lost` and refuse writes.
   - IndexedDB is used only where OPFS SAH is unsupported. That choice is recorded per origin and migrated explicitly if it ever changes, so OPFS and IndexedDB never hold disjoint copies.
   - On close: pause the VFS or terminate the worker **before** releasing the leader lock.
3. **Capacity and file ownership** (NEW-STORE-7, NEW-STORE-8).
   - `reserveMinimumCapacity(files + 2 + headroom)` before every open.
   - A Kora-owned manifest of the files it created.
   - Explicit `app.storage.listDatabases()` and `deleteDatabase(name)` APIs that refuse while unsynced ops exist.
   - **No automatic eviction, ever.**
   - On a failed open, remove only the file this open created, then release the worker and lock.
4. **Hung-leader failover** (NEW-STORE-9).
   - The leader pushes a heartbeat over BroadcastChannel, and followers fail pending requests with a typed error after missed beats.
   - Requests take an `AbortSignal` and carry request ids, so the leader dedups retried writes.
   - On `freeze` or `pagehide`, the leader releases the pool and lock so a visible tab takes over. Do not use the Web Locks `steal` option: the frozen tab's worker would still hold the file handles.
5. **Verification:** the Playwright suite `packages/store/tests/repro/browser/LMS-5-6-7.browser.mjs` (25 checks) joins CI. Add a real Android Chrome run for the freeze path; headless Chromium cannot freeze a tab.

**Effort:** 7 to 10 days. W8b, the original W8, stays in Phase 3.

### 9.4 W12 additions: an app that opens offline

1. **NEW-DX-3: the offline app shell.**
   - Ship a `korajs/vite` plugin, which the earlier review already wanted for the WASM and COOP/COEP plumbing. It generates a service worker that precaches the build manifest (hashed assets, `index.html`, the sqlite WASM and the OPFS proxy).
   - Navigation requests are served network-first, falling back to the cached shell.
   - Updates use a "new version available" flow that never mixes old and new assets.
   - Every template enables it by default, with an e2e test: load online, go offline, cold-reload, then read and write data.
   - Repro: `packages/server/tests/repro/browser/NEW-DX-3.offline-shell.mjs`.
2. **NEW-SRV-8: a production-grade static server**, which stays Kora's job because the templates ship it as the default.
   - Year-long immutable caching **only** for content-hashed files or files listed in Vite's manifest.
   - `no-cache` plus ETag and 304s for everything else, including `index.html`, the service worker and the manifest.
   - Serve pre-compressed brotli and gzip files (measured: 28s becomes 5.2s for a 177 KB bundle at 50 kbps).
   - A 404, not the SPA fallback, for missing files under the asset prefix.
   - Correct MIME types, including `.webmanifest` and `.wasm`.
   - Document a CDN for scale.
3. **NEW-STORE-4:** the persistence API described in 9.2.

### 9.5 Recommended reply to the LMS team

Thank them. Their production reports surfaced real problems: AUTH-13 at P0, the shared-device OPFS failures, and the backfill and delivery costs. Six of their 13 diagnoses were right in substance.

Explain plainly that the patches will not be merged as written:
- #3 and #8 open security holes.
- #6, #9 and #11 lose or leak data.
- #13 would break database opening after a sqlite upgrade.
- #2 and #5 do not work: `isOnline` does not exist, and sqlite-wasm caches the failed install.

Offer them the upstream designs in §9.2 to 9.4 and the repro suites, so they can drop their patches as each fix lands. Tell them to remove the #3 and #6 patches from production now: shared tablets are exactly where those two cause harm. Point out that their `__none__` convention is unnecessary, because omitting a collection already means "no access". Ask for a real Android device test of the hung-leader path.

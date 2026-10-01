# Phase 1 red-team review (2026-10-01)

Independent adversarial review of `fix/beta13-hardening` at 2840240 (W1 + W2 + S1 merged, before AUTH-11), run against the real `KoraSyncServer`, `createProductionServer` and `createKoraAuthServer` with exploit tests (deleted afterwards). Every finding is tracked in `remediation/tracker.json` as RT-n.

| ID | Sev | Finding | Location | Required fix |
|---|---|---|---|---|
| RT-1 | High (P0 in tracker: cross-tenant data) | Blob chunk requests are forwarded to every streaming session regardless of tenant, which leaks hashes. Any session can answer any pending requestId (poisoning). The central store serves any hash to any session (exfiltration). | `server/src/richtext/blob-chunk-relay.ts:116-190`; `kora-sync-server.ts:695-711` | Forward only to sessions in the same scope partition. Answer from the central store only if the requester's downlink scope contains a live record referencing the hash. Accept responses only from sessions the request was sent to. |
| RT-2 | High (P0 in tracker: session hijack) | HTTP long-poll: a caller-supplied `clientId` alone binds requests to an authenticated session. The bearer token is never checked after the handshake, so anyone knowing the clientId can read the stream and write as the user. | `kora-sync-server.ts:520-547, 931-948`; `HttpSyncRequest` type | Authenticate every HTTP request and require the same principal and device as the session. Use a server-issued, high-entropy session id bound to the principal. |
| RT-3 | Medium (P1) | Download visibility uses `buildScopeSnapshot`, where the writer's `previousData` overrides the stored row. A tenant can push orphan ops into other tenants' logs and hide ops from its own devices. | `server/src/session/client-session.ts:1500-1518`; `sync/src/scopes/scope-snapshot.ts` | Judge visibility on the server-materialized row plus `op.data`, never `previousData` (or rewrite `previousData` to server values at ingest). |
| RT-4 | High | Live sessions survive revocation and expiry; `bindSyncServer` called a non-existent `terminateSessions`. | | **Fixed** by the AUTH-11 merge (terminateSessions, expiry timer, provider `onRevoke`). The re-review must confirm. |
| RT-5 | Medium (P1) | `claimNode`: anonymous `MixedAuthProvider` clients get a new anon userId on every connection, so the second connection is locked out with `NODE_ID_CLAIMED` (confirmed). Squatting at upgrade (empty claims table plus visible node ids) is possible by code path. There is no admin release. | `client-session.ts:828`; stores' `claimNode`; `mixed-auth-provider.ts:104-108` | Skip or stably key claims for anonymous sessions. Seed claims from op history (or treat an unclaimed node with history as owned by its writer). Add an admin release API. |
| RT-6 | Medium (P2) | Refused ops each cost a store read before the rate limiter, and there is no per-batch op cap. 500 out-of-scope ops in one batch produced 500 rejections and 0 RATE_LIMIT. | `client-session.ts:1086-1139` | Charge the rate limiter and the per-batch op cap before any store read. |
| RT-7 | Low (P3) | The handshake echoes the write counts of any node id the client names in its own vector. | `client-session.ts:990-1000` | Reveal only nodes whose in-scope ops this session receives, plus its own. |
| RT-8 | Low (P2) | A grant with an `undefined`/`null` scope value matches records lacking the field. | `server-scope-filter.ts:43`, `matchesScopePredicate` | Reject `undefined`/`null` predicate values in `normalizeScopeMap` (fail closed). |
| RT-9 | Low (P3) | A refresh racing a device revocation can mint tokens that survive it (check, then consume, then sign with `iat = consumedAt`). | `auth/src/tokens/token-manager.ts` `rotate()` | Re-check revocation after consume, or sign successors with an iat taken before the check. |
| RT-10 | (P2) | Cascade side-effect ops are not re-authorized, and the `restrict` check counts other tenants' children. Read in code; untested. | `server/src/apply/apply-server-operation.ts:110-126` | Authorize side effects against the principal's scope, and scope restrict counts. |

**What held up** (re-verify in the re-review):
- Pre-handshake refusal on every message type, and duplicate handshakes refused.
- Forged `previousData`, `data.userId` takeover and same-id insert all refused against the stored row.
- `$in` narrowing works, `$claims` is stripped from handshakes, and missing bindings are denied.
- Foreign nodeId refused.
- Yjs is authorized and scoped; awareness is bound and partitioned.
- Postgres in-store authorize is serialized, and `consume`/`claimNode` are atomic.
- The grace replay window is safe after sign-out and revocation.
- The OAuth cookie is HttpOnly, Secure and SameSite=Lax.
- Offline ops are re-authorized at upload.

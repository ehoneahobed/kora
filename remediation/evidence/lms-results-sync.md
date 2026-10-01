# LMS report Part C (#8, #9): verification results

HEAD 91c6350 (1.0.0-beta.12). No existing files modified.
Repro files (new):
- `packages/test/tests/repro/lms-scope-harness.ts`: real KoraSyncServer + MemoryServerStore + SyncEngine + Store/SQLite over the memory transport, with per-device auth tokens. It has a hook for monkeypatching one engine instance.
- `packages/test/tests/repro/LMS-8.test.ts` (13 tests: 6 fail today as intended)
- `packages/test/tests/repro/LMS-9.test.ts` (16 tests: 5 fail today as intended)

Run: `cd packages/test && npx vitest run tests/repro/LMS-8.test.ts tests/repro/LMS-9.test.ts` (results are deterministic over 3 runs)

## Key structural fact for both items
The server sends `acceptedUplinkScopes` for every scoped session, including legacy single `scopes` (client-session.ts:747-766, 896). So the client's `hasDirectionalScopes` is true whenever the server has any scopes. A test asserts this.
- The name "hasDirectionalScopes" is misleading. It really means "server-scoped".
- Client query-subset filtering (`|| operationMatchesQuerySubsets`, sync-engine.ts:2088) already does not run in any server-scoped session.
- The LMS #9 patch therefore turns off client scope filtering in both directions for every scoped app, not only for directional RBAC.

## Callers (for both items)
There are three private copies of `buildSnapshot`, and none of them adds `id`. All layer `fullRecord < previousData < data`.
1. `packages/sync/src/scopes/scope-filter.ts:74`, via `operationMatchesScope`. Used by the client `matchesScopeAndSubsets` (sync-engine.ts:2085) with `activeUplinkScope`.
2. `packages/sync/src/scopes/query-subset.ts:18`, via `operationMatchesQuerySubsets`. Used by the client (only when the session is unscoped) and by the server `operationVisibleToClient`.
3. `packages/server/src/scopes/server-scope-filter.ts:132`, via `operationMatchesScopes`, `missingScopeFields` and `operationExitsScopes`. Used by:
   - server download visibility (client-session.ts:1318)
   - upload authorization (`operationAllowedFromClient`, :1340)
   - scope-exit retraction (:1349)
   - route-context (:344, :449), which passes no fullRecord at all

Client `operationAllowedForSync` → `matchesScopeAndSubsets` has these callers:
- `pushOperation` (:530, outbound live)
- `sendDelta` (:1274, outbound reconnect)
- the outbound requeue (:1882)
- `handleOperationBatch` (:1409, inbound)

The client backfills from the local row through `readRecordForBackfill` on a miss. The server backfills from the stored row through `lookupRecordFields` only when `missingScopeFields(op)` is non-empty.

Are `id` scopes supported? Not documented, and impossible in schema `sync` rules: `defineSchema` rejects the where-field because `id` is reserved and not in `fields`. They are only reachable through auth-provider scope maps (`scopes`/`downlinkScopes`/`uplinkScopes`, custom `OrgScopeResolver`). The generic `$in` matcher accepts them, and docs/guide/sync-configuration.md "Multi-partition authorization" implies any field works. So they are a de facto supported pattern.

---

## #8: buildSnapshot lacks `id`

**Problem verdict: PARTIAL.** The data loss is confirmed, but only on the client inbound path. The server download path is fine. The bigger issue is a security hole the report did not see, and their patch does not close it.

Evidence (end to end):
- **Inbound, client, legacy `scopes: {courses:{id:{$in:[A]}}}`.** The server delivers A, because `missingScopeFields` reports `id` missing and the lookup of the stored row supplies it. The client then drops it: the bare insert has no `id`, and there is no local row to backfill from. The student ends with 0 rows (expected `['A']`). FAILS today.
  - A collection-wide control scope delivers correctly.
  - The LMS client snapshot patch fixes it, and so does the planned SYNC-2 inbound split.
- **Directional (downlink `{}`, uplink id-scoped).** The client receives nothing (expected A and B). FAILS today. This is SYNC-2 (inbound judged by the uplink scope) compounded by the missing `id`. #8 alone would still drop B.
- **Server upload, update to an existing in-scope record:** accepted. PASSES today (stored-row backfill supplies `id`).
- **Server upload, insert whose recordId is in an id-scoped uplink:** rejected with SCOPE_VIOLATION. FAILS today.
  - Cause: there is no stored row to backfill from, so the snapshot has no `id`.
  - Practical relevance is low, because the client cannot choose ids (`insert` generates a UUIDv7). It matters for deterministic-id flows and the HTTP route API.
- **Route-context (by inspection):** `operationMatchesScopes(op, scope)` is called with no stored row. A route update's `previousData` holds only the picked changed fields, so any scope field the update does not modify (id or otherwise) fails. That is a broader bug than id; flag it to the SEC-2 owner.

**SECURITY.** Forged `id` is a write/delete authorization bypass, live today and not closed by the LMS patch. Session uplink is `{courses:{id:{$in:['allowed']}}}`; the stored rows are `allowed` and `victim`.
- Op `update recordId='victim', data:{id:'allowed',...}` is rejected today, but only by schema shape validation (SCHEMA_VALIDATION_ERROR: `id` is undeclared in `data`), not by authorization.
- Op `update recordId='victim', data:{title:'PWNED'}, previousData:{id:'allowed',...}` is accepted, and the victim row becomes 'PWNED'. FAILS today.
  - Shape validation explicitly allows `id` in `previousData` (`systemPreviousFields`, apply-server-operation.ts:130).
  - `missingScopeFields` sees `id` in the op, so no stored-row lookup happens and the forged id is trusted.
- Op `delete recordId='victim', previousData:{id:'allowed'}` is accepted and the victim is deleted. FAILS today.
- With the LMS patch applied to the server's upload authorization, the same previousData forgery still succeeds. FAILS.
  - `if (!('id' in merged))` defers to the attacker's id.
  - On a server without a registered schema, the `data.id` variant also gets past shape validation; this was shown at matcher level.
- The correct fix rejects all three forgeries. PASSES. A pure test also shows the shipped server and client matchers accept the forgery when given the stored row.

This is the SEC-2 class (op fields override the stored state). `id` is the most exploitable case because the validator whitelists `previousData.id`. The SEC-2 fix must cover it explicitly.

**Proposed-fix verdict: REJECT as written.**
- The conditional assignment lets an op-supplied `id` win.
- It is applied to snapshot builders that still layer `previousData`.
- On the client it becomes redundant once SYNC-2 lands (inbound no longer re-filters). With the LMS #9 patch it is already dead code for every server-scoped session.

**Recommended design.** Fold this into SEC-2 and SYNC-2:
1. **One shared scope-snapshot helper** in `@korajs/core` scopes, replacing all three copies:
   - pre-image = `{...storedRow, id: op.recordId}`
   - post-image = `{...storedRow, ...op.data, id: op.recordId}`
   - Never read `previousData` for authorization or visibility. `id` is always assigned last and unconditionally.
2. **Ingress validation:** reject (non-retriable INVALID_OPERATION) any op whose `data` or `previousData` contains `id` (or `_*` system fields) different from `recordId`. Apply it whether or not a schema is registered.
3. **Server `authorizeUplinkWrite` (SEC-2):**
   - update/delete: the stored pre-image must match the uplink scope.
   - insert/update: the post-image must match it, which also forbids moving a record out of scope.
   - insert with no stored row: post-image with `id=recordId`.
   - The stored-row lookup becomes unconditional for scoped collections (delete `missingScopeFields` as a gate). This depends on server state, so it composes with SRV-2's per-record visibility.
4. **Download visibility / SRV-2 and route-context:** use the same helper with the materialized row. route-context must pass `current`.
5. **Client:** after the SYNC-2 split, only `operationAllowedForUpload` evaluates scopes, against the local row through the same helper.

**Severity:**
- Client inbound id-scope drop: High (silent loss; affects only auth-provider id scopes).
- `previousData.id` forgery: Critical where id-scoped uplinks are used, and part of the already-Critical SEC-2.

**Effort:** S on its own (helper plus ingress check plus tests), mostly absorbed by SEC-2 and SYNC-2.

---

## #9: skip client filtering when hasDirectionalScopes

**Problem verdict: PARTIAL.** The symptom (server-delivered ops dropped by the client) is confirmed. The diagnosis ("incomplete data in the snapshot") is wrong for their scenario.

Their scenario: directional scopes, downlink `courseId ∈ {c1,c2}`, uplink `{c1}`, admin publishes a c2 lesson.
- The c2 lesson never arrives, and not even its insert. That insert carries `courseId:'c2'` and fails because the inbound filter uses `activeUplinkScope` (SYNC-2). FAILS today.
- A read-only learner (downlink `{c1}`, uplink `{}`) receives nothing. FAILS today.
- A missing field is not the cause here: with downlink equal to uplink, a partial `{status}` update of an already-synced record is delivered, because `readRecordForBackfill` supplies `courseId`. PASSES today.

The genuine "incomplete snapshot" drop exists elsewhere, independent of directional scopes. With legacy `scopes`:
- A fresh client gets insert(L1) and update(L1,{status}) in one delivery batch.
- `filterAllowedForSync` runs over the whole batch before anything is applied, so the update's backfill finds no row and the update is dropped.
- The delivery watermark still advances, because a filtered op counts as fully applied. The update stays lost for the whole session. FAILS today, both immediately and after 1s more in the same session.
- It reappears only after a reconnect, when it is re-sent and the row now exists (observed, PASSES). That breaks the gap-free delivery guarantee in CLAUDE.md.

The LMS patch makes all of the above pass, but only because `hasDirectionalScopes` is true for every scoped session. That reliance is accidental.

**Proposed-fix verdict: REJECT.**
1. **It disables the outbound uplink check too, for all scoped apps, not just directional ones.**
   - Writes to collections or records outside the session's uplink (local-only drafts, i.e. collections absent from the scope map) are transmitted to the server. That is a privacy leak: data meant to stay on the device leaves it.
   - The server rejects them with non-retriable SCOPE_VIOLATION, and they are re-sent and re-rejected on every reconnect. Measured: 1 rejection, then 3 after two reconnects. Cause: `sendDelta` recomputes from the server vector, and rejected ops are never in it.
   - Ack poisoning was not observed in this scenario: an in-scope op after the rejected one still uploaded. I did not try to construct the max-vector edge case.
2. It hard-codes a trust rule ("server already filtered") onto a flag with the wrong meaning. It leaves unscoped servers with a client-side `scopeMap` or query subsets on the old, broken path (the same-batch drop remains there).
3. Query-subset filtering is already skipped whenever the server is scoped, so that part of the patch is a no-op.

**Recommended design (planned split, validated):** inbound applies exactly what the server delivered, with no client scope or subset re-filter.
- A simulation (bypassing `filterAllowedForSync` only on the inbound path) passes every failing scenario: TA directional, read-only learner, same-batch insert+update, and the #8 id-scope inbound case.
- Outbound keeps `operationAllowedForUpload` (uplink scope only, with no query subsets, which also resolves SYNC-1). It evaluates against the local row through the shared #8 helper.
- An outbound op outside the uplink must not be silently kept local. Today that is a silent fork: the local value is edited, the server is unchanged, and nothing is rejected or emitted (FAILS today). It must be quarantined into the rejected store with an event, and never transmitted.
- Collections that are local-only by design need an explicit schema marker instead of the "absent from scope map" convention.
- If inbound ever deliberately drops an op (for example a schema transform that returns null), it must quarantine rather than advance the watermark silently.
- Rename `hasDirectionalScopes` or drop it.

**Severity:** High.
- Silent loss for every RBAC directional deployment (read-only roles receive nothing).
- Same-batch loss for every scoped app on first sync or catch-up.
- The proposed patch adds a privacy leak.

**Effort:** M, covered by the planned SYNC-2 split plus the quarantine path. The LMS patch should not be merged even as a stopgap. If an interim fix is needed, apply the inbound bypass only in `handleOperationBatch`.

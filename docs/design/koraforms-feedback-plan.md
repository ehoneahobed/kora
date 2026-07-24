# KoraForms Feedback: Plan and Design Notes

Source: KoraForms team feedback against Kora.js `1.0.0-beta.1`. Treated as the
external-proof loop, not a backlog dump. This document is the durable reference
so we do not lose the thread as work proceeds.

## Controlling principle

The framework owns **mechanism, protocol, and correctness** at the data plane.
It never owns **policy** or **app shape**. Every decision below resolves against
this line, and it is also how we decide where to stop.

## Per-item verdict

1. **Server-side operation validation before materialization** — OWN (mechanism +
   protocol). The real ask is trusted server-side adjudication of untrusted
   client operations before they become authoritative. This is what lets Kora
   serve public / multi-tenant offline apps at all, so it is north-star-defining
   and bigger than forms. Policy (schedule, limits, dedupe, payload caps) stays
   in the app's validator. Deep and risky; design as a first-class subsystem and
   prove with convergence tests. See "Item 1 design" below.
2. **Route-style mutation API outside HTTP handlers** — OWN (ergonomics). Mechanism
   already exists (`applyLocalOperation`, `req.kora.apply`). Expose a `server.kora`
   mutation context off the server handle.
3. **Sync size/rate limits at server config** — OWN (config surface + failure
   taxonomy). Promote `maxOperationBytes` / `maxOpsPerMinute` to server config;
   add a retryable-vs-permanent rejection taxonomy shared with item 1.
4. **Production server access to blob live-refs / GC** — OWN (ergonomics). Surface
   `getLiveBlobRefs()` / `collectBlobGarbage()` on the production server handle +
   a canonical central-blob-storage + scheduled-GC example.
5. **SQL identifier safety for collection names** — OWN (correctness bug). Quote
   identifiers consistently across adapters so camelCase works; add schema-time
   validation that fails early for genuinely unsafe names.
6. **Multi-runtime browser storage** — PARTIAL. OWN: OPFS/db lock diagnostics,
   a same-db-name-on-one-origin collision warning, and isolation docs. DECLINE:
   "helper APIs for common app shapes" (that is product shape, not a primitive).

Key insight: items 2, 3, 4 are one root cause — `createProductionServer`
over-encapsulates the `KoraSyncServer` it already owns. They collapse into a
single "ProductionServer public surface" workstream.

## Workstreams and sequence

Sequence chosen: cheap credibility first (low risk, unblocks the beta), then the
deep subsystem, then diagnostics/docs.

### A. SQL identifier safety (item 5) — FIRST

**Design decision (locked):** consistent double-quoting of every user-defined
identifier via a single `quoteIdent()` helper in `@korajs/core`. Double quotes
are honored by both SQLite and Postgres, preserve exact case, and make reserved
words (`order`, `select`) valid. This is what Prisma/Drizzle do. Chosen over a
reject-list because banning ubiquitous domain names (`order`, `group`, `to`) is
a wart a defacto framework can't have. The regex still relaxes to allow
camelCase/PascalCase (those are valid unquoted in SQLite; the regex was the only
thing rejecting them). `defineSchema` still fails early for genuinely malformed
names (empty, non-identifier characters).

**Root-cause scope (larger than first believed):** every adapter ultimately
hands SQL to a real SQLite or Postgres engine (the IndexedDB adapter is a thin
wrapper over SQLite WASM, not its own parser), so quoting is uniformly safe.
Consistency is all-or-nothing: a quoted CREATE paired with an unquoted SELECT on
any path reintroduces the keyword bug. Every site below must be converted.

Checklist (each: quote table names + user-defined column/field names; leave
framework columns `id`/`_created_at`/`_updated_at`/`_version`/`_field_versions`/`_deleted`
and framework op-log columns as literals; op-log TABLE names get `quoteIdent('_kora_ops_' + c)`):

- [x] `@korajs/core` `schema/quote-ident.ts` — new `quoteIdent()` helper + export
- [x] `@korajs/core` `schema/define.ts` — relax `COLLECTION_NAME_RE`
- [x] `@korajs/core` `schema/sql-gen.ts` — CREATE TABLE, ALTER, CREATE INDEX (data + op-log), REFERENCES, enum CHECK, columnDefinition
- [x] `@korajs/core` `migrations/migration-sql.ts` — ADD/DROP/RENAME COLUMN, CREATE/DROP INDEX, enum CHECK
- [x] `@korajs/store` `query/sql-builder.ts` — SELECT/COUNT FROM, ORDER BY, INSERT, all UPDATE/soft-delete/LWW, WHERE field conditions
- [x] `@korajs/store` `query/query-builder.ts` — relation SELECTs (table + fk field)
- [x] `@korajs/store` `store/store.ts` — data-table SELECT/UPDATE + `_kora_ops_` tables
- [x] `@korajs/store` `transaction/transaction-context.ts` — data-table SELECT + `_kora_ops_` tables
- [x] `@korajs/store` `mutations/execute-insert.ts` (routes via sql-builder, no change) / `execute-update.ts` / `execute-delete.ts`
- [x] `@korajs/store` `relations/relation-enforcer.ts` — source-collection SELECTs + `_kora_ops_`
- [x] `@korajs/store` `sync/rebase-unsynced-operations.ts` — data-table UPDATE/SELECT + `_kora_ops_`
- [x] `@korajs/store` `compaction/compact-operation-log.ts` — `_kora_ops_` table
- [x] `@korajs/store` `audit/export-audit.ts` — `_kora_ops_` table
- [x] `@korajs/store` `backup/backup.ts` — data tables + columns + `_kora_ops_` tables
- [x] `@korajs/store` `collection/collection.ts` — findById SELECT
- [x] `@korajs/store` `adapters/indexeddb-adapter.ts` — dump restore/export internal SQL (quote via helper; keep the safe-identifier guard)
- [x] `@korajs/server` `store/materialization.ts` — `generateCollectionDDL` (CREATE/ALTER/INDEX/CHECK) used by both server stores
- [x] `@korajs/server` `store/sqlite-server-store.ts` — findRecord/count/select/where, upsert columns, ON CONFLICT set
- [x] `@korajs/server` `store/postgres-server-store.ts` — same set as sqlite store
- [x] `@korajs/cli` `commands/migrate/migration-generator.ts` — its `quoteIdentifier` now actually double-quotes, so CLI-generated migrations are internally consistent with core's quoted CREATE

Key insight (found while doing it): the `sql-builder` helpers quote their own
`collection` argument, so every call site that routes through them (including all
`_kora_ops_` inserts) is quoted centrally and needed no change. Only direct SQL
string literals had to be touched.

Incidental pre-existing breakage fixed to keep the whole gate green (surfaced
because the full `typecheck`/`lint` gate had not been run to completion):
- `@korajs/core` `secret/secret-transform.ts` + `scripts/release/bump-beta.mjs`: `useTemplate` lint nits.
- `@korajs/store` `blob/opfs-blob-store.ts`: `globalThis` cast routed through `unknown`.
- `@korajs/sync` `blob/blob-chunk-channel.test.ts` + `protocol/serializer.test.ts`: missing `BlobChunkPushMessage` / `SyncMessage` type imports.
- `@korajs/server` `store/materialization.ts` + `@korajs/cli` `migrate/migration-generator.ts`: non-exhaustive field-kind switches (missing `object`/`json`/`blob`/`secret`) that returned `undefined` — a latent server/CLI DDL bug, now mapped to TEXT.

- Tests: camelCase collection round-trips create/insert/query (better-sqlite3);
  reserved-word collection (`order`) + field (`select`) round-trip; mixed-case
  preserves casing (`packages/store/tests/integration/sql-identifier-safety.test.ts`).
  Server round-trip through `SqliteServerStore` for a reserved-word collection
  (`packages/server/src/store/sqlite-server-store.test.ts`).
- Acceptance MET: camelCase/PascalCase/reserved-word names work end to end on
  client and server; genuinely malformed names still fail at `defineSchema`.
  Full gate green: build 16/16, typecheck 27/27, lint clean, `pnpm test` 30/30.

### B. ProductionServer public surface (items 2, 3, 4) — DONE

What shipped:
- [x] `server.kora` on the `ProductionServer` handle (`apply`/`query`/`findById`).
  It reuses the existing `createRouteContext(syncServer, store)` — the same
  stateless context custom HTTP routes get as `request.kora` — so a background
  job and an HTTP handler share one validated pipeline. No new mutation code.
- [x] `maxOperationBytes` / `maxOpsPerMinute` promoted to `KoraSyncServerConfig`
  (`types.ts`), threaded through `KoraSyncServer` into each `ClientSession` only
  when set (unset leaves the session default). `createProductionServer({ syncOptions })`
  gets them for free since it already forwards `syncOptions`. Enforcement already
  lived at the session layer; this exposes the knob at server config.
- [x] `server.getLiveBlobRefs()` on the handle (delegates to the sync server).
  `collectBlobGarbage` itself stays in `@korajs/store` — the server package must
  not import store (dependency rule) — so the canonical flow is
  `collectBlobGarbage(blobStore, await server.getLiveBlobRefs())`, documented in
  the new `docs/guide/production-server.md`.
- [x] Failure taxonomy: one shared `OperationRejection { code, message, retriable }`
  + `isRetriableRejection` in `apply/rejection-taxonomy.ts`. Threaded into
  `ApplyServerOperationResult.rejection`, `RouteApplyResult` failures, and the
  session's wire error (previously hardcoded `false`). Uses the existing wire
  spelling `retriable` and code `RATE_LIMIT`, not a second vocabulary. Reused in
  Workstream C.

Key decision: `req.kora` / `server.kora` are the SAME object. Exposing it was an
ergonomics change (surface what `createProductionServer` already builds), not new
mutation logic.

Tests: `server.kora` background-job apply/query/findById with no request; a
non-retriable constraint rejection through `server.kora`; `getLiveBlobRefs`
before/after a delete; `maxOpsPerMinute` and `maxOperationBytes` enforced against
a live session driven from server config (`kora-sync-server.test.ts`).

Acceptance MET: background jobs apply/query without a request; size/rate knobs set
at server config are enforced per client; the production server can run GC via
live refs.

### C. Server-side operation validation subsystem (item 1) — DONE

All four layers shipped and proven end to end. `validateOperation` on the server
config adjudicates each untrusted client op at ingestion (accept / reject /
ignore) via `OperationValidator` + `OperationValidationContext { auth, kora }`.
Reject sends a new `operation-rejected` protocol message (JSON + protobuf, fields
26-28) tied to the op id; the client's SyncEngine diverts the op out of the
outbound queue into a durable `_kora_sync_rejected` store (`StoreRejectedOperationStorage`),
emits `sync:operation-rejected`, and never retries it. `app.sync.getRejectedOperations()`
/ `clearRejectedOperations()` let the app reconcile. Convergence proven by a
two-device test in `@korajs/test`: accepted converges, rejected never becomes
authoritative (no divergence) and is kept + explained on the submitter (no loss),
and a rejected op is not resent. Guide: `docs/guide/server-side-validation.md`.
The `retriable` taxonomy from Workstream B is reused throughout.


**Mechanism vs policy split (locked):** the framework owns the *hook*, the
*routing* of its decision, and the *protocol + client recovery*. The app owns the
*validator function* (the policy: schedule open? within limits? spam?) and what it
does on accept (materialize as-is, or author a derived op via `server.kora`).

**The real distributed-systems gap (from the client-engine map):** the batch
`acknowledgment` deletes the WHOLE in-flight batch from the durable
`_kora_sync_queue`, with no per-op channel and no rejected state. So "no loss of
rejected ops" is not free — it needs a per-op reject message AND client-side
diversion of the rejected op into a durable rejected store (not the pending
queue), plus an app-observable event. Convergence holds because a rejected op
never enters the server's authoritative log, so every replica that syncs from the
server agrees without it; the submitter's local optimistic copy is surfaced as
rejected for the app to reconcile (roll back or resubmit) rather than silently
diverging.

Decision shape (reuses B's taxonomy):
```
type OperationDecision =
  | { action: 'accept' }
  | { action: 'reject'; code: string; message: string; retriable?: boolean }
  | { action: 'ignore' }   // server took responsibility (e.g. authored a derived op); client may drop it
```

Layered build + file checklist:

- Layer 1 — server hook + routing
  - [ ] `@korajs/server` `types.ts` — `validateOperation?` on `KoraSyncServerConfig` + `OperationValidationContext { auth, kora }`.
  - [ ] `@korajs/server` `session/client-session.ts` — run the hook in `handleOperationBatch` right before `applyServerOperation`; reject → send op-rejected + skip apply; ignore → skip apply, no rejection; accept → apply. Thread the hook + a `kora` context in from the server.
  - [ ] `@korajs/server` `server/kora-sync-server.ts` — hold `validateOperation`, build the route context once, pass both to each session.
- Layer 2 — protocol
  - [ ] `@korajs/sync` `protocol/messages.ts` — `OperationRejectedMessage { type:'operation-rejected', messageId, operationId, collection, recordId, code, message, retriable }` + union + type guard + `isSyncMessage` case.
  - [ ] `@korajs/sync` `protocol/serializer.ts` — protobuf envelope fields + `toProtoEnvelope`/`fromProtoEnvelope`/`encodeEnvelope`/`decodeEnvelope` cases (JSON is automatic).
- Layer 3 — client recovery
  - [ ] `@korajs/core` `events/events.ts` — `sync:operation-rejected` event (mirror `sync:apply-failed` shape).
  - [ ] `@korajs/core` `schema/sql-gen.ts` — `_kora_sync_rejected` framework table in `generateFullDDL`.
  - [ ] `@korajs/sync` `engine/sync-engine.ts` — handle `operation-rejected`: divert op out of the outbound queue, persist to the rejected store, emit the event. Do NOT auto-rollback the local write (app policy).
  - [ ] `@korajs/sync` `engine/outbound-queue.ts` — `reject(opId)` that removes the op from in-flight + memory + durable storage.
  - [ ] client rejected-op persistence (`kora/src` StoreQueueStorage sibling) + a read API (`app.sync.getRejectedOperations()` or via events).
  - [ ] `kora/src/wire-sync-event-forwarding.ts` — forward `sync:operation-rejected`.
- Layer 4 — tests + docs
  - [ ] Two-device convergence (`@korajs/test` or server integration): accept path — submitter's op accepted, owner converges; reject path — submitter gets structured reason, op in rejected store not pending queue, authoritative state excludes it, all synced replicas converge; replay stable.
  - [ ] Quarantine / anonymous-submission guide + example.

Acceptance: untrusted client ops adjudicated server-side before becoming
authoritative; rejected ops never propagate (no divergence) and are preserved +
explained on the submitter (no loss). Full gate stays green.

### D. Multi-runtime storage diagnostics + docs (item 6, partial) — DONE

What shipped (OWN: diagnostics + docs):
- `store:opfs-unavailable` event: the silent in-memory fallback (a data-loss
  trap) is now observable. The SQLite WASM worker classifies the OPFS failure
  (`lock-conflict` / `timeout` / `unsupported`) and reports the storage mode on
  the open response; `SqliteWasmAdapter` (now taking an `emitter`, threaded from
  `createApp`) emits the event when persistence degraded to memory.
- `store:db-name-collision` event: emitted when a runtime attaches to a dbName
  another runtime on the origin already owns (the follower path). Informational
  for multi-tab of one app; the clue a developer needs when two separate apps
  accidentally share the default `kora-db` name.
- Docs: `docs/guide/multi-runtime-storage.md` — leader/follower multi-tab,
  distinct store names for logically separate apps, the OPFS single-writer model,
  the two diagnostics, and naming conventions.
- Tests: `SqliteWasmAdapter` emits `store:opfs-unavailable` on a non-persistent
  open, and nothing on a persistent open or when the bridge reports no mode.
- DECLINED (as planned): app-shape helper APIs (a built-in workspace + respondent
  runtime split). That is product shape, not a primitive; the docs show how to
  compose it with distinct store names instead.

## Status

- [x] A. SQL identifier safety
- [x] B. ProductionServer public surface (2, 3, 4)
- [x] C. Server-side operation validation subsystem (1)
- [x] D. Multi-runtime diagnostics + docs (6, partial)

All four workstreams complete. Every KoraForms feedback item is addressed:
1 (C), 2/3/4 (B), 5 (A), 6 (D, partial per the controlling principle).

Each workstream: build the correctness core with tests, wire integration, run
biome + full build + touched-package suites, changeset, sync to Mac.

## Beta.2 follow-up round

Source: KoraForms integration against `1.0.0-beta.2`. Beta.2 confirmed to resolve
A/B/C/D. Three items remain, each resolved against the controlling principle.

### E. Conditional atomic multi-collection apply on server routes — OWN (mechanism)

The ask: an authoritative admission gate that atomically reads current state,
checks a predicate, and commits a multi-collection mutation set, or rejects with a
structured reason. Race-free hard-cap admission across multiple server instances,
without process-local locks. Generalizes past forms (inventory, seat booking,
unique claim, rate caps), so it is a data-plane correctness primitive, not policy.
KoraForms supplies the predicate and the rejection code; Kora supplies the gate.

Design (agreed with KoraForms):
- Declarative shape, NOT interactive `transaction(tx, { forUpdate })`. Maps onto the
  single atomic store transaction the server stores already run (op-insert + version
  vector + materialize); on Postgres a conditional `WHERE` update is serialized
  across instances by the DB. Interactive `forUpdate` implies pessimistic locks held
  across await points and does not port to non-SQL adapters. Declined for now.
  ```ts
  await kora.apply({
    collection: 'forms', id: formId,
    if: { status: { $eq: 'published' }, responseCount: { $lt: maxResponses } },
    update: { responseCount: op.increment(1) },
    also: [{ collection: 'responses', op: 'insert', id: responseId, data: response }],
    reject: { code: 'max_responses_reached', message: '...' },
  })
  ```
- Predicate is an admission gate evaluated ONCE at the authoritative server, atomic
  with the writes. Admitted mutations become ordinary immutable log entries; the
  condition is not re-evaluated on replay. Determinism, HLC ordering, fan-out intact.
- Whole set commits in one server-store transaction or none. On failure the `reject`
  is returned to the route AND, for ops arriving via sync, surfaced through
  `getRejectedOperations()`. One rejection, two entry points.
- Operators: `$eq`, `$ne`, `$lt`, `$lte`, `$gt`, `$gte`, `$in` (confirmed sufficient).
- No-cap case is the same call minus the `responseCount < maxResponses` clause.
- Idempotency (confirmed with KoraForms): the whole admitted set is keyed on a stable
  `clientSubmissionId` (also the accepted response record id), created once per
  submission attempt and reused on every retry. Online retry after a blip returns the
  already-accepted response; offline replay converges through the same accept/reject
  path; `op.increment(1)` runs at most once per admitted-set id. This is the one
  genuinely new correctness requirement: the increment is not naturally idempotent.
- Offline boundary (agreed, CAP, not a Kora gap): the gate gives race-free admission
  only for ops that transit the server online. It cannot extend a hard global cap to
  offline-authored ops synced later. That overflow case is KoraForms product policy
  (default: reject-on-sync with `max_responses_reached`; optional soft-cap review),
  already composable today via `validateOperation` + `kora.query`.

- [x] `RouteConditionalApply` type (`if` / `update` / `also` / `reject` /
      `idempotencyKey`) on `ProductionHttpRouteContext`, plus `applyConditional`.
- [x] Predicate language `evaluateRoutePredicate` (`$eq`/`$ne`/`$lt`/`$lte`/`$gt`/
      `$gte`/`$in`), pure and unit-tested (6 tests).
- [x] Per-instance atomic admission: predicate evaluated against materialized state,
      then the target update + `also` set applied inside the route's serialized block.
- [x] At-most-once via `idempotencyKey` (a retry returns the prior outcome and does
      not re-run the counter increment). Tested.
- [x] Fixed a latent gap: the route `apply` path now resolves atomic-op sentinels
      (`op.increment` etc.) into concrete `data` + `atomicOps` intent, so server-
      authored atomic writes compose in the merge engine like client writes.
- [x] All-or-nothing on validation: the whole set is built and scope-checked before
      any commit, so a malformed / out-of-scope `also` mutation cannot leave the
      target increment committed. Tested.
- [x] Tests: accept (increment once), reject at cap (nothing applied, structured
      code), idempotent retry (no double increment), all-or-nothing on a bad `also`,
      no-cap multi-collection set. Full server suite green (262 tests).
- [x] Signature shared with KoraForms in this thread; matches their sketch.

REMAINING for E (deliberately deferred, cannot be safely done or verified in the
current sandbox; both are genuine engineering, not oversights):
- [ ] Cross-instance race-free admission + all-or-nothing across a mid-set crash:
      a store-level conditional transaction (`ServerStore` method) with row locking.
      On Postgres a `SELECT ... FOR UPDATE` on the target inside the transaction, then
      a guarded commit. NEEDS a live-Postgres integration environment to certify (the
      repo's Postgres tests run against a fake Drizzle, not a real DB), so it must land
      with CI-backed concurrency tests, not blind. Today's per-instance serialization
      is correct for single-instance deployments (KoraForms' current shape).
- [ ] Server-side atomic-op composition in materialization (discovered while building
      E): the server op table does NOT persist `atomicOps`, and `replayOperationsForRecord`
      is last-write-wins over resolved `data`. So CONCURRENT increments to one record
      converge correctly on CLIENTS (merge engine, tested) but the server's materialized
      projection can lose a delta. It does not affect a server-serialized counter
      (KoraForms' responseCount), but it is a real latent gap for client-driven shared
      counters read via the server. Fixing it is a schema migration (persist atomicOps)
      + a replay change across SQLite/Postgres/Memory/backup, with property tests. Must
      not be rushed pre-publish.

### F. Leader/follower multi-tab hardening (item 6, follow-up) — OWN (correctness)

Symptom: a second offline tab opened while the first public-form tab is alive can
fail to hydrate the cached form ("Form not found"). Root cause: the leader/follower
fallback (used when SharedWorker is unavailable, e.g. Chrome on Android, some
webviews) assumes a continuously responsive leader. It has NO leader-liveness
heartbeat, NO follower failover/re-election, and NO readiness handshake. A follower
proxies reads to the leader tab over BroadcastChannel with a 30s timeout and no
recovery, so a browser-throttled backgrounded leader tab makes the follower time out.

- [ ] Leader heartbeat + follower promotion when the leader goes unresponsive
      (`navigator.locks` already hands the lock over when the holder dies).
- [ ] Readiness handshake so a follower created before a leader relay is live retries
      instead of failing.
- [ ] Regression test (KoraForms' 5-step case) in the store multi-tab suite: tab A
      caches online, offline, tab A submits and stays open, tab B opens same URL
      offline, tab B hydrates cached form + shows local pending count.

### G. SharedWorker host response mis-correlation — OWN (correctness), BUG

Found while diagnosing F. KoraForms tried the SharedWorker path (the throttle-proof
default) and their public offline suite regressed: form never reached "Available
offline", durable queued-submission scenarios failed. Root cause is a real bug in
`sqlite-wasm-shared-host.ts`: the direct `WebWorkerBridge` reassigns a unique
`id` (`this.nextId++`) per request, but `SharedWorkerClientBridge.send()` forwards
the adapter's request unchanged (adapter always sends `id: 0`), and the host
correlates the inner worker's replies by `request.id`. With `id` always `0`,
`pool.pending.set(0, ...)` is overwritten whenever two ops overlap (the suite
pipelines hydration reads against durable outbound-queue writes; multiple tabs make
it worse), so one physical response resolves the wrong logical request and the other
times out. Passes single-op checks, breaks under concurrency.

- [ ] Assign a unique inner request id at the host boundary (where all ports/tabs
      converge) and correlate on it, mirroring `WebWorkerBridge`. Per-`WorkerEntry`
      monotonic id, map innerId -> { requestId, port }.
- [ ] Concurrency test: N overlapping requests across M ports all resolve correctly.
- [ ] Once fixed, re-run KoraForms' offline suite against the SharedWorker path; it is
      the preferred throttle-proof default once correct (keeps F as the fallback).

Status: E, F, G open (beta.2 follow-up). E and F acknowledged to KoraForms with the
agreed design; G root-caused on our side and to be reported back as a closed loop.

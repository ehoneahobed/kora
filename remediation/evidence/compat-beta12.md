# Compatibility with 1.0.0-beta.12 (Phase 4, 2026-10-03)

The last published release is **1.0.0-beta.12** (git tag `v1.0.0-beta.12` = `91c6350`).
Commit `33bca46` (the Phase 1 merge) was never released; earlier probes and the Phase 2
and 3 red teams used it as the legacy client and server and called it "beta.13".
Everything (Phases 1 to 4) ships together as **1.0.0-beta.13**, so the only clients and
servers in the field are beta.12 and older. Protocol numbers are unchanged: protocol 1 =
beta.12 and older, protocol 2 = this release.

This file is the matrix of every legacy scenario run against the real beta.12 build, with
results after the fixes on this branch (RT-88 to RT-92).

## How it was run

- beta.12 built from `git archive v1.0.0-beta.12` in a private temp dir
  (`pnpm install --frozen-lockfile && pnpm build`); the unreleased Phase 1 build
  (33bca46) the same way, for the comparison rows.
- `scripts/remediation/compat-beta12.mjs <beta12-build>`: Node, real WebSockets, the real
  `createApp` of each build on better-sqlite3, the real servers of each build on memory,
  SQLite and Postgres 16 (own instance, port 54422, `initdb -E UTF8 --locale=C.UTF-8`).
  Every write shape beta.12 produces: plain and nested-`undefined` inserts, top-level and
  nested `undefined` clears, increments (concurrent across builds), arrays, objects,
  json with a `Date`, timestamps, binary richtext (Yjs updates), unicode (U+2028,
  supplementary plane), `5e-324`, transactions (beta.12 gives a transaction and the
  next single write one sequence number, STORE-1, and concurrent transactions one number),
  a cascading delete, a delete.
- Chaos: each build's own `ChaosTransport` wrapped around its real `WebSocketTransport`
  (10% drop, 5% duplicate, 5% reorder, up to 30 ms latency), 2 beta.12 + 2 current
  clients, 3 rounds x 25 random writes per client with offline stretches, then heal
  (faults off, reconnect), a fresh current peer, then the beta.12 devices upgrade their
  databases in place.
- `scripts/remediation/compat-beta12-browser.mjs <beta12-build>`: real Chromium
  (`PW_CHROMIUM_PATH=/opt/pw-browsers/chromium`), the real beta.12 `createApp` and worker
  bundled from the beta.12 dist, then a page of this release on the same origin.
- The four earlier probes (`rt-legacy-id-probe.mjs`, `rt3-legacy-probe.mjs`,
  `rt3-upgrade-clear-probe.mjs`, `protocol-v2-compat.mjs`), re-pointed to beta.12.

## Matrix

"Current" is this branch. Every row passes after the fixes unless marked otherwise;
"observation" rows record documented behaviour.

| # | Scenario | Stores | Result |
|---|---|---|---|
| 1 | beta.12 client + current client, current server, every write shape | memory, SQLite, Postgres | Converge (12 records); concurrent increments 1+2+10+100 = 113 everywhere; a beta.12 cascade deletes the current client's child; nothing rejected or quarantined. Server warnings: `session.protocol_deprecated`, `session.legacy_sequence_pair` (beta.12 STORE-1 pairs, up to 4 operations under one sequence number). Before RT-88 one op per run was stored unverified (`session.unverified_legacy_operation`, the Date in json). |
| 2 | Two current clients + beta.12 client, beta.12 server | memory, SQLite | Current replicas converge exactly (113). The beta.12 client keeps beta.12 merge semantics: through a beta.12 server it misses a concurrent increment (13 instead of 113, memory) until it upgrades. |
| 3 | beta.12 database (offline writes, never synced) opened by current client, then synced | better-sqlite3 | Rows unchanged on open; converges with a fresh peer; the write beta.12 numbered like the transaction before it arrives. Failed before RT-88 (`INVALID_OPERATION_ID`, write undone). |
| 4 | beta.12 database synced with a beta.12 server; both upgrade (server on the same SQLite file) | better-sqlite3, SQLite | Rows unchanged; converges. |
| 5 | beta.12 database synced with a current server, then upgraded | better-sqlite3 | Rows unchanged; converges. |
| 6 | beta.12 server database upgraded by current server, no auth: a beta.12 device stays on beta.12, another upgrades its database, a fresh device joins; both old devices have unsynced offline writes | SQLite, Postgres | Converge; every offline write arrives. The `undefined` clear beta.12 peers never saw (the JSON wire dropped it) is applied everywhere after the upgrade (RT-71/RT-85 one-time pass), matching what the writer applied. |
| 7 | Same, token auth | SQLite, Postgres | Upgraded device: refused `NODE_ID_CLAIMED` (pre-claims history, RT-5), moves to a fresh node, uploads only what beta.12 never acknowledged: converges, no double increment. Failed before RT-90 (offline write held forever as `other-user`; the first fix attempt re-authored everything and counted the +5 increment twice: 13 instead of 8). beta.12 device: refused until `server.releaseNodeClaim(nodeId)` (documented operator path), then converges with its offline write. |
| 8 | Same, anonymous (`MixedAuthProvider`) | SQLite, Postgres | Converge; warning `session.legacy_anonymous_claim`. Failed before RT-89 (both old devices refused for good). |
| 9 | Mixed fleet under chaos, current server, 12 seeds | SQLite server | 12/12: current replicas and a fresh peer converge; beta.12 replicas differ on 0 to 4 records (concurrent merges under beta.12 rules) and converge after upgrading. Seed 6 of an earlier run failed (RT-92). |
| 10 | Mixed fleet under chaos, beta.12 server, 12 seeds | SQLite server | 12/12 after RT-91. Before: seed 8 failed (provisional cascade kept on the streaming author of a late child). |
| 11 | Browser: beta.12 app on SQLite WASM / OPFS (origin-wide `kora-opfs` pool), opened by current app, then synced next to a Node peer | OPFS | Rows unchanged; `store:storage-migrated` (per-database pool), `store:rematerialized` (log); converges with the peer; STORE-1 write arrives. |
| 12 | Browser: beta.12 app on IndexedDB, opened by current app, synced | IndexedDB | Rows unchanged; `store:rematerialized`; converges. |
| 13 | `rt-legacy-id-probe.mjs` (6 shapes) | memory | 6/6 accepted and converged. Stored `v1` (verified) except nested-object `undefined` members (`v-`, schema rebuild not declarable). |
| 14 | `rt3-legacy-probe.mjs` (6 shapes) | memory | 6/6. |
| 15 | `rt3-upgrade-clear-probe.mjs` (3 cases x local, synced, offline) | memory | 9/9 same / converged. |
| 16 | `protocol-v2-compat.mjs` (current clients through a beta.12 server; beta.12 client on current server) | memory | Both ok; deprecation warned; legacy ops `hashVersion` 1, current 2. |
| 17 | Encryption (observation): beta.12 client with `encryption`, current server optional / required / required + `allowPlaintextMigration` | memory | Refused terminally: `SCHEMA_VALIDATION_ERROR` / `PLAINTEXT_REJECTED` / `SCHEMA_VALIDATION_ERROR` (migration admits plaintext, never protocol-1 ciphertext). A schema-aware beta.12 server refused them too. After the device upgrades, its refused write stays local (terminal rejection). Two current clients with the same passphrase do not exchange data either (ENC-1, open, owned by the encryption workstream). Documented in `docs/guide/sync-encryption.md` and the notes. |
| 18 | Encryption (observation): current encrypted clients through a beta.12 server | memory | Nothing reaches the peer (the old server drops the envelope). Documented ("encrypted sync requires a beta.13 server"). |
| 19 | Unreleased Phase 1 build (33bca46), probes 13 to 16 | memory | All pass (comparison only; no such build in the field). |

## Differences between beta.12 and 33bca46 that the legacy paths assumed

| Area | beta.12 | 33bca46 (what the code assumed) | Consequence | Fix |
|---|---|---|---|---|
| Version-1 hash of a `Date` in a json value | `{}` (canonicalize walks `Object.keys`); log and wire hold the ISO string | same code, never probed | Upgraded device's offline write refused and undone | RT-88: rebuild ISO strings as `{}` (not declarable) |
| Node claims on the server | none recorded | claims rows (`kora:anonymous`, per user) | Every anonymous node refused after a server upgrade | RT-89 |
| Local node registry seeding | `last_acked_server_vector` only | node token / claims-aware server | beta.12 database counted as "accepted by a claims-aware server": refusal held its writes forever | RT-90 (and the acknowledged floor when re-authoring) |
| Server-derived cascades | none (protocol 1) | none either, but probes never streamed through it | Provisional cascades kept while streaming | RT-91 (generalised by RT-92) |
| Transaction sequence numbers (STORE-1) | the next single write re-uses the transaction's last number; concurrent transactions share numbers; up to 4 ops seen under one number | the counter persisted inside commits; only concurrent transactions collide | More legacy pairs; covered by `legacy_sequence_pair` storage and the client sequence repair (rows 1, 3, 11) | none needed |
| Scope-entry inserts, `fieldVersions`, `nodeToken`, `foldState` | absent (the beta.12 JSON decoder drops them) | understood `fieldVersions` and `nodeToken` | beta.12 clients apply a scope entry as a plain insert (residual below) | documented |
| Encryption envelope | v1 (`data` replaced by ciphertext) | same | refused (row 17) | documented |

## Defects found and fixed

| ID | Sev | Summary | Repro |
|---|---|---|---|
| RT-88 | P1 | beta.12 hashed a `Date` in json as `{}`: upgraded device's pre-upgrade write refused `INVALID_OPERATION_ID` and undone | `packages/server/tests/repro/RT-88.test.ts`; row 3 |
| RT-89 | P1 | Anonymous beta.12 devices refused for good after a server database upgrade, despite `allowLegacyAnonymousClaims` | `packages/server/tests/repro/RT-89.test.ts`; row 8 |
| RT-90 | P1 | beta.12 database seeded as accepted: its offline writes held forever after the server upgrade (and naive re-authoring doubled acknowledged increments) | `packages/store/tests/repro/RT-90.test.ts`, `sync/src/engine/local-nodes.test.ts`; row 7 |
| RT-91 | P2 | Provisional cascade kept by a streaming device behind a beta.12 server | `packages/test/tests/repro/RT-91.test.ts`; row 10 |
| RT-92 | P2 | Same with a current server when no server copy confirms the effect (repeated delete of a deleted parent) | `packages/test/tests/repro/RT-92.test.ts`; row 9 |

## Residual risks

- **Other `toJSON` objects in beta.12 json values** (a `URL`, Luxon/Moment/Decimal
  instances, a custom class): beta.12 hashed their enumerable fields, the wire carries
  their JSON form. Uploaded by a beta.12 client they are stored unverified (RT-71
  fallback); uploaded from an upgraded device's pre-upgrade log they are refused
  `INVALID_OPERATION_ID` and undone. Mitigation: let beta.12 devices sync before they
  upgrade. A general fix (accept unverifiable own-node version-1 ids from protocol-2
  sessions) would contradict the RT-64 repro and was not made.
- **Authenticated beta.12 clients after a server upgrade** stay refused until an admin
  releases their node (RT-5 decision; operator procedure in
  `docs/guide/production-server.md`). Releasing hands the node to the first principal
  that presents it.
- **`MixedAuthProvider` deployments**: with `allowLegacyAnonymousClaims`, an anonymous
  device can take a signed-in user's beta.12 node with pre-claims history (as on
  beta.12). Documented on the option.
- **RT-90 floor**: on the refusal path, an operation at or below the beta.12 server's
  acknowledged entry is treated as stored. A beta.12 STORE-1 duplicate kept in place by
  the sequence repair that the beta.12 server never stored is not re-sent (the repair
  renumbers the other members of each pair above the entry, so only one per pair).
- **Scope entries for beta.12 clients**: a beta.12 client applies the server's scope-entry
  insert at its single timestamp (it drops `fieldVersions`/`foldState`); a concurrent
  offline edit of such a record on that beta.12 client can lose until the record's next
  write (the upgraded client keeps the logged entry without versions). Needs scopes, a
  record re-entering scope and a concurrent offline edit on the beta.12 device.
- **beta.12 Node clients crash on a dropped socket**: beta.12's `SyncEngine` throws
  "WebSocket is not connected" from an un-awaited flush; under Node's default
  `--unhandled-rejections=throw` that terminates the process (seen in the chaos rows; the
  harness records them). Fixed by upgrading the client.
- **Mixed-fleet semantics**: beta.12 clients keep beta.12 merge rules (arrays,
  increments relayed by a beta.12 server, object members) until they upgrade; their
  first open of this release re-folds every record and they converge (rows 2, 9, 10).
- **Chaos coverage**: 24 seeded runs (12 per server build) of about 300 writes each;
  timing makes runs nondeterministic, so a seed is not a reproduction.

## Commands

```bash
git archive v1.0.0-beta.12 | tar -x -C /tmp/b12   # then pnpm install --frozen-lockfile && pnpm build in /tmp/b12
KORA_PG_TEST_URL=postgres://postgres@127.0.0.1:54422/compat COMPAT_SEEDS=1,2,3,4,5,6,7,8,9,10,11,12 \
  node scripts/remediation/compat-beta12.mjs /tmp/b12
PW_CHROMIUM_PATH=/opt/pw-browsers/chromium node scripts/remediation/compat-beta12-browser.mjs /tmp/b12
for p in rt-legacy-id-probe rt3-legacy-probe rt3-upgrade-clear-probe protocol-v2-compat; do
  node scripts/remediation/$p.mjs /tmp/b12
done
```

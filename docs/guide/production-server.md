---
title: Production Server
description: "Run the Kora production server: trusted data-plane access for background jobs via server.kora, server-config size and rate limits, central blob storage, and scheduled blob garbage collection."
---

# Production server

`createProductionServer` serves your built client, the WebSocket sync endpoint,
and a set of operational endpoints on a single port. Beyond serving requests, the
handle it returns exposes the same data plane your clients sync against, so
background work, scheduled jobs, and central blob maintenance all run through the
one validated pipeline instead of poking at the store directly.

```typescript
import { createProductionServer, createSqliteServerStore } from '@korajs/server'
import { defineSchema, t } from 'korajs'

const schema = defineSchema({ version: 1, collections: { todos: { fields: { title: t.string() } } } })

const store = createSqliteServerStore({ filename: './kora-server.db' })
await store.setSchema(schema)

const server = createProductionServer({
  store,
  port: Number(process.env.PORT) || 3001,
  staticDir: './dist',
  syncPath: '/kora-sync',
  syncOptions: { schemaVersion: schema.version },
  operationalAuth: {
    adminToken: process.env.KORA_ADMIN_TOKEN,
    metricsToken: process.env.KORA_METRICS_TOKEN,
    backupToken: process.env.KORA_BACKUP_TOKEN,
  },
})

const url = await server.start()
```

`store.setSchema(schema)` lets the server validate operations, materialize collections, enforce
relations and constraints and fold `merge` strategies; without it the server only stores and
relays operations. Add `auth` to `syncOptions` for any multi-user deployment (see
[Authentication](/guide/authentication)): without an auth provider every connection is accepted.

## Server options

`createProductionServer(config)`:

| Option | Default | Description |
|--------|---------|-------------|
| `store` | (required) | A server store: `createSqliteServerStore`, `createPostgresServerStore` or `MemoryServerStore`. |
| `port` | `PORT` env, else `3001` | Port to listen on (`0` picks a free one; `start()` returns the URL). |
| `staticDir` | `'./dist'` | Built client to serve. |
| `syncPath` | `'/kora-sync'` | WebSocket sync endpoint. |
| `syncOptions` | | Everything the sync server accepts (below). |
| `httpRoutes` | | Your HTTP routes; each handler gets `request.kora` (the trusted data plane). |
| `operationalAuth` | | `adminToken`, `metricsToken`, `backupToken` for `/__kora/*` (status, events, metrics, backups). An omitted token leaves its endpoints **public**: set at least `adminToken` and `backupToken` in production. |
| `trustProxy` | none | Trust `X-Forwarded-For` only from these proxies (a hop count or a CIDR list); `request.ip` uses it. |
| `maxRequestBodyBytes` | 1 MiB | Larger bodies of custom routes get `413` before they are buffered. |
| `maxBackupBytes` | 256 MiB | Largest backup import. |
| `crossOriginEmbedderPolicy` | `'credentialless'` | COEP header for the served app. |

`syncOptions` (also the config of `createKoraServer` / `KoraSyncServer`):

| Option | Default | Description |
|--------|---------|-------------|
| `auth` | none | Auth provider (`createKoraAuthServer().auth`, `TokenAuthProvider`, `MixedAuthProvider`, ...). |
| `validateOperation` | | Your policy for each incoming operation ([Server-side Validation](/guide/server-side-validation)). |
| `schemaVersion`, `supportedSchemaVersions`, `operationTransforms` | from the store's schema | Accepted client schema versions and the transforms between them. |
| `encryption` | | `{ required: true }` refuses plaintext uploads (`PLAINTEXT_REJECTED`) unless `allowPlaintextMigration`. |
| `maxConnections` | 10,000 | Concurrent sessions; one more gets a retriable `MAX_CONNECTIONS`. |
| `maxMessageBytes` | 32 MiB | Largest WebSocket message. |
| `maxOpsPerBatch` | 1000 | Largest upload batch (`BATCH_TOO_LARGE`). |
| `maxScopePredicateValues` | 100 | Most values in one `$in` grant predicate (`SCOPE_PREDICATE_LIMIT` above it). See [Large grants](#large-grants-the-in-value-limit). |
| `maxOperationBytes` | 256 KiB | Largest operation (`OPERATION_TOO_LARGE`, per operation). |
| `maxOpsPerMinute` | 600 | Per device node (`RATE_LIMIT`, retriable). |
| `maxOpsPerMinutePerUser` | 4 x `maxOpsPerMinute` | Per authenticated user across their devices; `0` disables. |
| `blobLimits` | | Chunk size (1 MiB), bytes per session (256 MiB), pending requests, requests per minute (6000). |
| `heartbeatIntervalMs` | 25 s | WebSocket ping interval; two missed pings end the session. |
| `appHeartbeatIntervalMs` | 25 s | Application `heartbeat` messages for browsers. |
| `handshakeTimeoutMs` | 10 s | Time a connection has to hand-shake. |
| `maxBufferedBytes` | 32 MiB | Unsent bytes before a slow consumer is disconnected. |
| `deliveryHighWaterBytes` | 1 MiB | Queued bytes above which a client's delivery stream pauses. |
| `perMessageDeflate` | on | Compress messages of 1 KiB or more. |
| `sessionRevalidationIntervalMs` | 30 s | Re-check every live session's credential and scope. |
| `httpSessionIdleTimeoutMs` | 2 min | HTTP long-poll sessions without requests are closed. |
| `allowLegacyAnonymousClaims` | `true` | See [Anonymous devices](#anonymous-devices-and-node-claims). |
| `deviceNodeHandover` | `true` | Claim an ownerless node (beta.12 history, or released) for the signed-in user whose verified device id equals it. See [Upgrading a beta.12 server database](#upgrading-a-beta-12-server-database-with-authentication). |
| `anonymousClaimTtlMs` | 24 h | |
| `resolveBlobChunk`, `persistBlobChunk` | | Central blob storage (below). |
| `batchSize`, `relayRetransmitIntervalMs`, `deliveryPollIntervalMs` | 100, 2 s, 2 s | Delivery tuning. |
| `logger`, `metricsCollector`, `emitter`, `enableDashboard` | | Observability. |

## Server identity

Every server store authors its own writes (route mutations, cascades and set-nulls, constraint
corrections) under the node id `kora:server:<deploymentId>:<instanceId>`:

- The **deployment id** and a derivation secret are created on first start and stored in the
  database (`kora_server_meta`), shared by every instance that uses it. Server-derived operation ids
  (cascades, corrections) are keyed with that secret, so every instance derives the same id and no
  client can predict one.
- The **instance id**: SQLite persists one (one database, one process). Postgres draws a fresh one
  from a database counter at every start; set `instanceId` per instance for a stable one, and never
  give two running instances the same id.
- Every `kora:server:` node id is authoritative for `merge('server-authoritative')` fields on every
  replica. Node ids that wrote such fields before the upgrade are recorded once as legacy
  authoritative ids and advertised in the handshake, so earlier server decisions keep winning.
  Add ids with the store option `authoritativeNodeIds` (a back-office service) and revoke them,
  permanently, with `revokedAuthoritativeNodeIds`; removing an id from the list does not revoke it.
- No device can act as the server: a handshake with a `kora:` node id, the server's node id or any
  authoritative id is refused with `INVALID_NODE_ID`. The old store option `nodeId` is deprecated:
  a value is kept as a legacy authoritative id, not used for authoring.

## Postgres

`createPostgresServerStore({ connectionString })` (install the `postgres` package) is the store for
production and for more than one instance:

- Use a **UTF8** database (the default). Strings are stored losslessly: U+0000 and unpaired
  surrogates, which Postgres `TEXT` and `JSONB` cannot hold, are escaped in materialized rows; an
  identifier holding them is refused (`INVALID_IDENTIFIER`), and any value the database still
  refuses is a per-operation `UNSTORABLE_VALUE` rejection, never a dropped session.
- **First start of 1.0.0-beta.13** runs one-time migrations: sequence columns become `BIGINT`
  (an exclusive table rewrite, once: schedule it), new tables (`operation_resolutions`,
  `sequence_pairs`, the fold state, `kora_server_meta`, `kora_encryption_keys`, `blob_owners`,
  `node_claims`) are created, operation scope snapshots are computed, every record is re-folded
  once in 500-record transactions (safe during a rolling deploy), and the log-integrity scan runs.
  Later starts re-fold only records whose fold state is missing or stale (a warm restart at 20k
  operations re-materializes nothing).
- Version vectors are read from the database, so they are correct across instances; duplicates
  are refused atomically; delivery sequences are assigned through one counter row, so delivery
  order matches commit order across instances.
- A Postgres error of class 22 or 23 (other than a unique violation) refuses that one operation
  (`UNSTORABLE_VALUE`); it never blocks the device's later writes.

## Operation log integrity

On their first start of this release the SQLite and Postgres stores read every stored operation
once and move rows that cannot be read back into an operation (malformed JSON, an out-of-range
timestamp) to an `operations_quarantine` table, verbatim, so no fold ever reads them. A warning is
logged; `store.getLogIntegrityReport()` returns the result. A record that owns quarantined
operations keeps its pre-fold row as the base its remaining and later writes fold onto. Later
starts skip the scan.

## Static files and the offline app shell

The server serves `staticDir` (default `./dist`) the way an offline-first app needs:

| Request | Response |
|---|---|
| Content-hashed file (`assets/index-DrBNyszg.js`) | `Cache-Control: public, max-age=31536000, immutable` |
| Anything else (`index.html`, `sw.js`, `manifest.webmanifest`, the unhashed `assets/sqlite3.wasm`) | `Cache-Control: no-cache`, revalidated with the `ETag` and answered `304` only when the content is unchanged |
| Compressible types (JS, CSS, HTML, JSON, SVG, WASM) | Brotli or gzip per `Accept-Encoding`, with `Vary: Accept-Encoding`. A pre-compressed `file.br` / `file.gz` from your build is used when it decompresses to the file's current bytes; otherwise each file version is compressed once and cached in memory |
| A missing path requested by a **navigation** (`Accept: text/html`) | `index.html` (the SPA shell) |
| Any other missing path, and every missing path under `/assets/` | `404`, so a stale tab asking for an old chunk after a deploy fails loudly instead of parsing HTML as JavaScript |

Validators come from the content, never from file metadata alone: the `ETag` is a SHA-256 of
the file's bytes (computed once per file version and cached by path, size, mtime, inode and
ctime). Revalidated files send no `Last-Modified` and ignore `If-Modified-Since`, because
`index.html` and `sw.js` usually keep their size across deploys and reproducible or container
builds normalise modification times; a redeploy is therefore always seen. Content-hashed files
also send `Last-Modified`.

Media types include `.webmanifest` (`application/manifest+json`), `.wasm` and `.mjs`.
Only `GET` and `HEAD` are served; paths cannot escape `staticDir`, lexically (`..`, encoded
separators) or through a symbolic link: every file, directory `index.html` and pre-compressed
sibling is served only when its real path is inside the real path of `staticDir`, and an escape
answers `404`, like a missing file. Links that stay inside `staticDir` keep working, and
`staticDir` may itself be a link (an atomic `current -> releases/N` deploy is followed per request).

The scaffolded templates add a service worker (`sw.js`, generated into `dist/` at build
time by `koraServiceWorker()` from `@korajs/cli/vite`) that precaches this shell, so the
app opens with no network at all after one online visit. See
[Offline patterns](./offline-patterns.md#opening-the-app-offline-the-app-shell).

**At scale**, put a CDN in front of the static files. The headers above are CDN-safe:
hashed assets can be cached at the edge forever, and the shell, service worker and
manifest revalidate on every request. Never let a CDN cache the sync endpoint
(`/kora-sync`) or the auth routes (`/auth/*`).

## Trusted data-plane access for background jobs

The handle carries a `kora` context: `apply`, `query`, and `findById`. It is the
same object handed to custom HTTP routes as `request.kora`, so a scheduled task
and an HTTP handler share one code path and one set of guarantees. Every mutation
runs through Tier 2 constraints, referential integrity, materialization, and
fan-out to connected clients, which is exactly what writing to the store directly
would skip.

<!-- docs-check-prelude
import { createProductionServer, createSqliteServerStore } from '@korajs/server'
import type { ProductionHttpRouteContext } from '@korajs/server'
const store = createSqliteServerStore({ filename: './kora-server.db' })
const server = createProductionServer({ store })
declare const request: { kora: ProductionHttpRouteContext }
declare const body: { title?: string; notes?: string }
declare const recordId: string
-->

```typescript
// A nightly job that closes stale invitations. No HTTP request involved.
const stale = await server.kora.query('invitations', {
  where: { status: 'pending' },
})

for (const invite of stale) {
  const result = await server.kora.apply({
    collection: 'invitations',
    type: 'update',
    recordId: invite.id,
    data: { status: 'expired' },
  })

  if (!result.ok && !result.retriable) {
    // Permanent rejection (a constraint or referential conflict): the same
    // mutation will never succeed, so log it rather than retrying.
    console.error(`invite ${invite.id} rejected: ${result.code}: ${result.message}`)
  }
}
```

**`undefined` in an update clears the field**, exactly as `app.<collection>.update()`
does on a device (an update's `field: undefined` is written as `null`). A route that
forwards optional request fields therefore clears every field the request omitted:

<!-- docs-check: continue -->
```typescript
// Clears `notes` whenever the request body has no `notes`:
await request.kora.apply({ collection: 'todos', type: 'update', recordId, data: { notes: body.notes } })

// Writes only the fields the request carries:
const data = Object.fromEntries(
  Object.entries({ title: body.title, notes: body.notes }).filter(([, value]) => value !== undefined),
)
await request.kora.apply({ collection: 'todos', type: 'update', recordId, data })
```

This is deliberate: one meaning of `undefined` everywhere (device API, route writes,
beta.12 clients), so a write means the same thing on every path. Route writes are also
held to the [value domain](./schema-design.md#value-domain): a value outside it (a
`Date` in a `t.timestamp()` field, a fractional timestamp, a value of an undeclared enum
member) is refused with `SCHEMA_VALIDATION_ERROR` and nothing is written.

Every failed `apply` carries a `retriable` flag. `true` means the rejection is
transient (a rate limit) and resubmitting the identical operation may later
succeed; `false` means it is permanent for the operation as written (a constraint
violation, a referential conflict, a malformed mutation, a scope violation) and
retrying the same bytes will always fail. This is the same `retriable` flag the
sync protocol sends connected clients on the wire, so one classification serves
both server-side callers and remote clients.

## Sync size and rate limits

Two payload guards are enforced per connected client at sync ingest. Set them
once at the server level through `syncOptions` and every session inherits them:

```typescript
const limited = createProductionServer({
  store,
  syncOptions: {
    maxOperationBytes: 256 * 1024, // reject any single operation larger than 256 KiB
    maxOpsPerMinute: 600, // per device node, fixed one-minute window
  },
})
```

An operation over `maxOperationBytes` is rejected on its own as a permanent
`OPERATION_TOO_LARGE` (the same bytes can never fit): the client records the refusal
(`sync:operation-rejected`) and the server keeps acknowledging the client's later
operations. Devices refuse such a write before it is accepted when their
`store.maxOperationBytes` matches the server's (default 256 KiB on both). Exceeding `maxOpsPerMinute`
yields a retriable `RATE_LIMIT` (the client should back off and resend). Both
defaults (256 KiB and 600 ops/min) apply when you omit the knobs.

Blob chunk requests have their own budget, `blobLimits.maxRequestsPerMinute`
(default 6000 per client): a large blob is one request per chunk, so it must not
compete with operation sync. A request over that budget is answered with a
retriable `throttled` response carrying `retryAfterMs`; the Kora client waits and
asks again instead of failing the download (`createRemoteChunkProvider` options
`maxThrottleWaitMs`, `minThrottleDelayMs`, `maxThrottleDelayMs` bound the wait).

## Large grants: the `$in` value limit

A grant that lists many values for one field (`spaceId: { $in: [...] }`, one entry per
document, form or workspace a user belongs to) is capped at `maxScopePredicateValues`
values per predicate, 100 by default. A larger grant is refused at handshake with
`SCOPE_PREDICATE_LIMIT`, so a provider bug cannot hand a session an unbounded predicate.
Raise it when your users legitimately belong to more spaces:

```ts
const server = createProductionServer({
  store,
  syncOptions: { auth, maxScopePredicateValues: 1_000 },
})
```

What a larger grant costs, measured with `pnpm --filter @korajs/server bench:scope-in`
(Node 22, one core; a log of 20,000 operations over 5,000 spaces; the session reads the
same 400 operations at every size, so only the predicate grows; medians of three runs):

| Values | Handshake, fresh device (SQLite / Postgres 16) | Revalidation, per session per pass | Live delivery, per write to 20 sessions |
|---|---|---|---|
| 1 (baseline) | 316 / 312 ms | 0.07 / 0.02 ms | 7.5 / 16.2 ms |
| 100 (default) | 609 / 481 ms | 0.13 / 0.13 ms | 7.3 / 15.4 ms |
| 1,000 | 600 / 518 ms | 0.9 / 1.1 ms | 7.6 / 17.0 ms |
| 5,000 | 677 / 628 ms | 5.2 / 8.7 ms | 8.1 / 17.7 ms |

Handshake and delivery hardly move: a large `$in` list is looked up through a set, so
testing an operation against it costs the same at 100 or 5,000 values (the handshake
column is dominated by reading the log; the step from 1 to 100 values is the 400
operations the session now receives). The cost that grows with the grant is the
revalidation pass: every live session's credential is re-authenticated and its grant
rebuilt and compared every `sessionRevalidationIntervalMs` (30 s), which is linear in the
grant's size (and includes your provider's own work to build it).

Recommendation: keep the default unless you need more; **up to 1,000 values is safe**
(about 1 ms per session per pass: 1,000 live sessions cost about 1 s of CPU every 30 s).
5,000 works for modest session counts (5 to 9 ms per session per pass, so 1,000 sessions
at that size spend 15 to 30 % of a core on revalidation) and is the practical ceiling.
Beyond that, do not list memberships in the grant: give users a coarser scope value
(a team or workspace id that many records share) so the list stays short.

## Central blob storage and scheduled garbage collection

When you want blob bytes to outlive the device that authored them, back the
server with a central blob store. `toServerBlobCallbacks` turns any
`ContentAddressedBlobStore` (such as `FilesystemBlobStore`) into the
`resolveBlobChunk` / `persistBlobChunk` pair the sync server needs:

```typescript
import { collectBlobGarbage, toServerBlobCallbacks } from '@korajs/store'
import { FilesystemBlobStore } from '@korajs/store/blob-fs'

const blobStore = new FilesystemBlobStore('/var/kora/blobs')

const blobServer = createProductionServer({
  store,
  syncOptions: {
    ...toServerBlobCallbacks(blobStore),
  },
})

await blobServer.start()
```

Because blobs are content-addressed and stored out of band, deleting the record
that referenced a blob does not reclaim its bytes. `getLiveBlobRefs()` returns
every reference still reachable from a live record, which is precisely the live
set a mark-and-sweep collector needs. Run it on a schedule:

<!-- docs-check: continue -->
```typescript
// Reclaim orphaned blob bytes once an hour.
setInterval(async () => {
  const liveRefs = await blobServer.getLiveBlobRefs()
  const result = await collectBlobGarbage(blobStore, liveRefs)
  console.log(`blob gc: reclaimed ${result.collected} objects, kept ${result.live}`)
}, 60 * 60 * 1000)
```

`collectBlobGarbage` never deletes anything reachable from `liveRefs`, so a blob
a record still points at is always safe, even mid-upload. Only bytes no live
record references are removed.

### Who can read a blob

**A content hash is not a secret.** Hashes of well-known files can be computed by
anyone, and they travel inside records, manifests and logs. Kora therefore never
treats knowing a hash as permission to read it:

- A session can fetch blob bytes (from the central store or from a peer) only when a
  live record inside its own download scope references them.
- A write may put a blob reference into a record only when the writer can already
  read a record that references the same content, or has uploaded the bytes itself
  (proof of possession). Otherwise the write is refused with `SCOPE_VIOLATION`. The
  Kora client uploads a blob's bytes before the operation that references it, so
  this is automatic.
- With central storage, the store serves bytes only to a session that uploaded them
  or whose download scope references them, and a bare reference never claims a hash
  (RT-25): a writer cannot reference content it does not hold in the hope that
  another tenant uploads it later.
- A manifest may only list chunks its uploader may reference.

Without central storage (peer-to-peer blob transfer), the server still asks clients
to push the bytes behind each reference (`blobPossessionProof` in the handshake
response). It verifies them against their hash, records the pusher as an owner,
and drops them (RT-23), so two tenants that hold identical files can both reference
them. This costs one upload of each blob to the server per device; the bytes still
travel between peers for reads. In this mode only, the first writer of a hash
nobody references or owns may also claim it by reference alone (there is no stored
copy to read back), for clients that cannot push.

#### Residual: content-existence oracle

Hash checks reveal a little. In peer-to-peer mode, whether a bare reference to a
hash is accepted (unowned) or refused (someone else references or owns it) tells the
writer whether *some* tenant holds that exact content. With central storage the
answer is always "refused unless you pushed it or can already read it", so the
reference check reveals nothing; response timing (a store lookup for owned hashes)
is not constant-time. Nothing is readable through either signal: bytes and
references never cross a scope. Treat the existence of a specific, guessable file (a known template,
a public document) as observable by other tenants of the same server. Content an
attacker cannot guess byte-for-byte (anything with private data in it) has an
unguessable hash and is not exposed.

## Session re-validation across instances

Revoking a device or a user is persisted by the auth stores, but the revocation
listener that ends live sync sessions runs only in the process that handled the
revocation. Every `KoraSyncServer` therefore re-validates its own live sessions with
its auth provider every `sessionRevalidationIntervalMs` (default 30 seconds, also
driven by the delivery poll tick), and ends the ones whose credential is no longer
accepted with a retriable `AUTH_REVOKED`. A provider error ends nothing; the next pass
retries. On a `KoraSyncServer`, `revalidateSessions()` runs a pass immediately and
`terminateSessions({ userId, deviceId })` ends matching sessions at once.

The same pass re-resolves each session's sync scopes from the fresh authentication.
When a principal's download or upload scope changed (removed from a team, a role
change), the session is ended with a retriable `SCOPE_CHANGED`; the client
reconnects and is handed its new scope at handshake, so a narrowed grant takes
effect within one revalidation interval rather than at token expiry (RT-26).

### Applying a membership change at once

When your grant depends on data your app changes (an invitation accepted, a
collaborator removed, a role changed), call `refreshScopes(userId)` right after the
change instead of waiting for the next pass. It is available on the
`ProductionServer` handle and on `KoraSyncServer`, next to `revalidateSessions()`:

```ts
await removeCollaborator(documentId, bobId)
await server.refreshScopes(bobId)
```

Each of that user's live sessions re-authenticates. A session whose download or
upload scope changed ends with a retriable `SCOPE_CHANGED`, its client reconnects at
once and receives the new grant: with `scopeExit: 'retract'` the rows that left the
scope are hidden on that device, and the device's unsynced writes outside its new
upload scope are refused (`sync:operation-rejected`). Sessions whose grant did not
change are kept. A session still in its handshake re-checks once it is established,
so a grant read just before the change does not outlive the call. The call resolves
to the number of sessions it ended.

`refreshScopes` reaches this process's sessions only. With several instances, the
others apply the change at their next revalidation pass; to make it immediate
everywhere, publish the user id to every instance (for example over Redis pub/sub)
and call `refreshScopes` on each.

## Records moving into a scope (scope entry)

Each operation is delivered according to the scope values its record had right
after that operation was applied (so a new owner never receives the history written
while the record belonged to someone else). When an operation moves an existing
record INTO a session's scope (an ownership transfer, a team change), the server
sends that session a server-built **scope-entry** operation just before it: an
`insert` carrying the record's current values and its **fold state**
(`foldState`), from the system node `kora:scope-entry` (sequence 0, deterministic id
per triggering operation). Devices join the fold state with their own, so counters,
rich text, resolvers and arrays keep a device's concurrent edits; each restated field
keeps exactly its own version, so it never overrides a newer local edit. The new
owner's devices, live or freshly signed in, see the complete record and can edit it.

The previous owner's devices see the record leave: with `scopeExit: 'retract'` it is
hidden from their view; with the default `'retain'` they keep the last copy they had
(no longer updated). Node ids in the `kora:` namespace are reserved; a handshake
using one is refused with `INVALID_NODE_ID`.

Snapshots of each operation's scope values are captured with the schema in force
when it was applied. When a migration adds, renames or retypes a field, the store
recomputes every snapshot from the log at `setSchema` (it keeps a fingerprint of the
captured fields), and a scope field a snapshot does not hold is judged on the
record's current row, so adding a scope field never hides existing history.

## Anonymous devices and node claims

An anonymous device's node id is bound to a per-device token the server issues at
the first claim. The claim is provisional until the device proves it saved the
token: the Kora client acknowledges the handshake response with the token right
after persisting it (or presents it at its next handshake). A provisional claim
whose response was lost in transit is re-issued to the device when it reconnects
without a token, as long as no session is connected as that node and the claim is
younger than `anonymousClaimTtlMs` (default 24 hours). A device that is refused
`NODE_ID_CLAIMED` anyway moves to a fresh node id and re-sends every unsynced write
under it (event `sync:node-id-rotated`), so no write is lost.

`allowLegacyAnonymousClaims` (default `true` in 1.0.0-beta.13, `false` from the next
release) keeps clients without token support working: nodes whose history predates
node claims (every node of a database a beta.12 or older server wrote), nodes held by
the pre-release shared anonymous owner, and provisional claims that expired
unconfirmed, are re-issued with a `session.legacy_anonymous_claim` warning in the log.
Set it to `false` once every client is on beta.13 or later. With `MixedAuthProvider`,
a node with pre-claims history may also be a signed-in user's beta.12 device, which an
anonymous device can then take (as it could on beta.12); set the option to `false` if
that matters more than keeping anonymous beta.12 devices syncing.

### Upgrading a beta.12 server database with authentication

beta.12 and older servers recorded no node claims, so after the upgrade every node id
in the database has history and no owner.

**From 1.0.0-beta.14 the handover is automatic.** When a signed-in device presents an
ownerless node id (history but no claim, or released by an administrator) and the node
id equals the device id the auth provider verified for that user, the server claims
the node for that user in one atomic store step (`claimUnownedNode`) and the handshake
proceeds; the device's queued offline writes upload. The built-in `KoraAuthProvider`
reports the device id from the token's `dev` claim, which always names a device
registered to that user, so `@korajs/auth` apps need no script. A node another user
owns is never taken, and another user presenting the node id is still refused
`NODE_ID_CLAIMED`. Each handover is logged as `node_claim.handover`.

Two things to know:

- The handover trusts the auth store's device registrations. A device id that no
  account holds (accounts kept in memory on beta.12, as in every beta.12 template, are
  gone after the upgrade) belongs to the first user who registers it, exactly as with
  the script below: give the server a persistent user store and let users sign in
  again on their own browsers.
- The claim decides ownership from now on. History written under the node on beta.12
  may include operations another user forged (beta.12 did not verify node ids); use the
  [operation log integrity](#operation-log-integrity) scan to audit it.

A custom `AuthProvider` takes part only if it sets `metadata.deviceId`, and must set it
only to a device id it verified as the user's. Set `deviceNodeHandover: false` in the
sync server options to keep the beta.13 behavior (refuse, bind by hand).

The rest of this section applies to **servers still on beta.13**, or with
`deviceNodeHandover: false`. A signed-in device is not handed an ownerless node, so its
handshake is refused `NODE_ID_CLAIMED`:

**Apps using `@korajs/auth` (`createKoraAuthSync`, the default in every sync template).**
These clients use the signed-in device id as their node id and cannot change it, on
beta.12 and beta.13 alike. Until their node is bound to its owner, every existing device
stays refused (status `offline`, reconnecting; beta.13 clients also emit
`store:persistence-error` with code `NODE_ROTATION_FAILED`) and its offline writes never
upload. The script below binds each node with history to the user who owns the auth device
with that id, leaves every other node alone, and never replaces a claim another user holds.
It is safe to run again.

**First, check where your accounts live.** If your beta.12 `server.ts` passed no
`userStore` to `createKoraAuthServer` (no beta.12 template did), accounts and devices were
kept in memory and are already gone, so there is nothing to bind yet. Give the server a
persistent user store (`createSqliteUserStore` or `createPostgresUserStore`, as the beta.13
templates do). A browser keeps its device id, so when a user signs up again there, the device
registers under its old id and is refused. Run the script after users have signed up again
(stop the server, run it, start the server), and again for users who come back later. To let
every device reconnect at once instead, release the ownerless nodes with
`releaseNodeClaim(nodeId)`, accepting that the first signed-in user to present a node id
gets it.

**Running it.** Save the script at the root of your app as `bind-node-claims.ts` (the app's
`package.json` needs `"type": "module"`, as in every template). Stop the sync server, run
`node --env-file=.env --import tsx bind-node-claims.ts` (drop `--env-file=.env` if you keep
no `.env`), then start the server. If the upgraded server already ran, do the same: refused
devices sync once their node is bound. Run it from a checkout of the app with its dev
dependencies installed: a `kora deploy` image contains only the bundled server. For SQLite on
a deployed volume, stop the app, copy both database files out, run the script, and copy them
back; for Postgres, point `DATABASE_URL` at the production database.

With SQLite (the template default):

<!-- docs-check: standalone -->
```ts
import { existsSync } from 'node:fs'
import { createSqliteUserStore } from '@korajs/auth/server'
import { createSqliteServerStore } from '@korajs/server'

// The same files your sync server opens (the templates read these variables).
const serverDb = process.env.KORA_SERVER_DB || './.kora/kora-server.db'
const authDb = process.env.KORA_AUTH_DB || './.kora/kora-auth.db'
for (const file of [serverDb, authDb]) {
  if (!existsSync(file)) throw new Error(`${file} not found: point the script at your server's files`)
}
// The user store your auth server uses. A custom UserStore works too: only findDevice() is called.
const users = await createSqliteUserStore({ filename: authDb })
const store = createSqliteServerStore({ filename: serverDb })

let nodes = 0
let matched = 0
let bound = 0
for (const nodeId of await store.getNodeIdsAfterDelivery(0)) {
  if (nodeId.startsWith('kora:')) continue
  nodes++
  const device = await users.findDevice(nodeId)
  if (!device) continue
  matched++
  // A real owner is kept. '' means an administrator released the node: bind it.
  if (await store.getNodeClaimOwner(nodeId)) continue
  await store.releaseNodeClaim(nodeId)
  if (!(await store.claimNode(nodeId, device.userId))) throw new Error(`could not bind ${nodeId}`)
  bound++
}
await store.close()
if (nodes === 0) throw new Error(`${serverDb} has no operations: is this your sync database?`)
if (matched === 0) throw new Error('No node matches an auth device: is this the right user store?')
console.log(`${bound} bound now, ${matched - bound} already claimed, ${nodes - matched} without an auth device`)
```

With Postgres (`DATABASE_URL` in the templates; the `NOTICE ... already exists, skipping` lines
it prints are harmless):

<!-- docs-check: standalone -->
```ts
import { createPostgresUserStore } from '@korajs/auth/server'
import { createPostgresServerStore } from '@korajs/server'

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error("Set DATABASE_URL to your sync server's database")
const users = await createPostgresUserStore({ connectionString })
const store = await createPostgresServerStore({ connectionString })

let nodes = 0
let matched = 0
let bound = 0
for (const nodeId of await store.getNodeIdsAfterDelivery(0)) {
  if (nodeId.startsWith('kora:')) continue
  nodes++
  const device = await users.findDevice(nodeId)
  if (!device) continue
  matched++
  if (await store.getNodeClaimOwner(nodeId)) continue // '' (released) is bound
  await store.releaseNodeClaim(nodeId)
  if (!(await store.claimNode(nodeId, device.userId))) throw new Error(`could not bind ${nodeId}`)
  bound++
}
await store.close()
if (nodes === 0) throw new Error('The database has no operations: is this your sync database?')
if (matched === 0) throw new Error('No node matches an auth device: is this the right user store?')
console.log(`${bound} bound now, ${matched - bound} already claimed, ${nodes - matched} without an auth device`)
process.exit(0) // the Postgres user store keeps its connection open
```

An app that binds nodes itself on a beta.14 server (a boot script, an admin route) should
call `store.claimUnownedNode(nodeId, userId)` instead of `releaseNodeClaim` followed by
`claimNode`: it is one atomic step, so a server instance still running during a rolling
deploy cannot take the node between the two calls.

With a custom user store, construct it as your server does. Revoked devices are bound too:
they stay signed out (auth enforces revocation), and if the user signs in again on that
browser, the device id comes back and syncs. Another user who presents a bound node id is
still refused `NODE_ID_CLAIMED`. On a browser that two users shared on beta.12, the node is
bound to the device's first owner. The other user can no longer sign in on that browser
(`DEVICE_OWNERSHIP_CONFLICT`), and their unsynced writes on it upload under the first owner's
account when that owner next signs in there. If that matters, have those users sync before
the upgrade.

**Apps with token auth (`sync.auth`):**

- A beta.13 client moves to a fresh node id and uploads its writes the old server
  never acknowledged under it; what that server acknowledged stays under the old node
  (the server already holds it). Nothing is lost and nothing is applied twice. Upgrade
  clients when you upgrade the server.
- A beta.12 client cannot change its node id: it keeps reconnecting and its unsynced
  writes stay on the device until an administrator calls
  `server.releaseNodeClaim(nodeId)` for that node (the next principal to connect with
  it claims it). To keep beta.12 clients syncing through the upgrade, release their
  node ids (`SELECT DISTINCT node_id FROM operations` lists them) before they
  reconnect, accepting that the first principal to present a released node id gets it.

## Gap-free delivery and the delivery-sequence migration

The server guarantees that once an operation is in its log, it reaches every client whose scope includes it and is never silently skipped, across dropped messages, reconnects, client restarts, and scoped sync. This is driven by a server-assigned delivery sequence and a per-client delivery watermark, and it needs no configuration. The guarantee and its client-side behavior are described in [Sync configuration: delivery guarantees](./sync-configuration.md#delivery-guarantees), and the wire fields in [Sync Protocol](./sync-protocol.md#delivery-watermark).

Two operator notes:

- **First startup after upgrading runs a one-time migration.** Each store adds a `delivery_seq` column and backfills existing operations. This is automatic and idempotent. On a very large Postgres operation log the backfill is a single ordered pass under an advisory lock; it runs once and subsequent startups skip it.
- **Operation scope snapshots and blob owners (beta.13).** Each store adds a nullable `scope_snapshot` column to `operations` and a `blob_owners` table. Download visibility of a historical operation is judged on the record's scope values when that operation was applied, so an ownership transfer does not disclose the earlier history to the new owner, and scope-exit retractions come from the server's own rows. Existing operations are backfilled from the log when the schema is set (one replay per record); operations of collections outside the schema keep the previous behavior. Blob uploads made before the upgrade have no recorded owner: their existing references keep working, and a new reference to such bytes needs the writer to upload them again.
- **Operation log integrity check.** See [Operation log integrity](#operation-log-integrity).
- **Postgres serializes delivery-sequence assignment through one counter row** so delivery order matches commit order across instances. This is a deliberate correctness-over-throughput choice and is not a bottleneck for typical sync workloads. If you run a single Postgres at very high sustained write rates and measure contention on it, that is the place to look first.

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
| `httpRoutes` | | Your HTTP routes; each handler gets `request.kora` (the trusted data plane) and answers JSON (`body`), HTML (`html`) or bytes (`raw` with your `Content-Type`). |
| `shellMeta` | | Per-URL title, description and Open Graph tags for the app shell, so shared links preview the page they point at. See [Link previews](#link-previews-and-per-page-metadata). |
| `spaFallback` | `'navigation'` | Which missing paths get the app shell: `'navigation'` (browser navigations and crawlers), `'strict'` (browser navigations only) or `'extensionless'` (any extensionless path). |
| `operationalAuth` | | `adminToken`, `metricsToken`, `backupToken` for `/__kora/*` (status, events, metrics, backups). With `NODE_ENV=production`, endpoints whose token is unset are **disabled** (`403 OPERATIONAL_ENDPOINT_DISABLED`; `allowPublic: true` serves them anyway); outside production they are public, with a startup warning (`server.operational_endpoints_unprotected`). |
| `trustProxy` | none | Trust `X-Forwarded-For` only from these proxies (a hop count or a CIDR list); `request.ip` uses it. |
| `maxRequestBodyBytes` | 1 MiB | Larger bodies of custom routes get `413` before they are buffered. |
| `maxBackupBytes` | 256 MiB | Largest backup import. |
| `crossOriginEmbedderPolicy` | `'credentialless'` | COEP header for the served app. |

`syncOptions` (also the config of `createKoraServer` / `KoraSyncServer`):

| Option | Default | Description |
|--------|---------|-------------|
| `auth` | none | Auth provider (`createKoraAuthServer().auth`, `TokenAuthProvider`, `MixedAuthProvider`, ...). |
| `validateOperation` | | Your policy for each incoming operation ([Server-side Validation](/guide/server-side-validation)). |
| `onOperationsCommitted` | | Runs after every committed batch on this instance, uploads and server writes alike ([Reacting to committed writes](/api/server#operations-committed)). |
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
| `unscopedSharing` | `'warn'` | A signed-in grant that restricts no collection (every user syncs everyone's data): `'warn'` once, `'allow'` silently, or `'refuse'` the session (`UNSCOPED_SHARING_REFUSED`). |
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
- **Changing transforms or merge rules in a rolling deploy** is safe: each fold state records
  the plan it was folded with, so a record an instance on the previous plan writes meanwhile is
  folded again with the new plan, by the re-fold if it has not reached the record yet and
  otherwise by the next delivery poll of an instance on the new plan (`refoldOutdatedRecords`,
  with the membership index moved in the same transaction). Until then (one poll), such a record
  is read with its previous-plan values by queries outside a transaction (`server.kora.query`,
  `findById`, sync delivery). Record reads inside a transaction are not: there, access
  rules judge the stored and the resulting record as the deciding instance's plan folds it, and
  every read of a `server.kora` transaction or conditional set (`tx.findById`, `tx.query`, its
  `if` predicate, the current value an `op.increment` resolves against, the constraint and
  relation checks of its writes) sees the record folded with that plan, read-only and with no
  database privilege beyond reading (records on the current plan are read as stored). A check made before that transaction (a session's
  early refusal of an upload) may still see the previous-plan row: it can refuse a write early,
  never admit one, since the check in the transaction decides. `tx.roleOf` reads the membership
  index, which a previous-plan write indexes with that plan's values until the re-fold moves it
  (one poll). Instances on the previous plan never fold records back.
  Two rules keep this true: change transforms in a deploy of its own, not together with a Kora
  upgrade (an older Kora does not record the plan), and if an instance of the previous release
  restarts during the rollout (it records its plan again), restart one new instance once the
  rollout is done.
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

### json values stored as strings

After an upgrade from a server older than beta.13, check for `t.json()` / `t.object()` values that
older clients wrote as JSON-encoded strings (the old server decoded one string layer when it built
rows; beta.13 and later store exactly what was written):

<!-- docs-check: skip imports the app's own schema module -->
```ts
import { createSqliteServerStore, findJsonStringValues } from '@korajs/server'
import schema from './src/schema'

const store = createSqliteServerStore({ filename: './.kora/kora-server.db' })
await store.setSchema(schema)
for (const report of await findJsonStringValues(store)) {
  console.warn(`${report.collection}.${report.field}: ${report.count} rows`, report.sampleIds)
}
await store.close()
```

Each report names a field, how many live rows hold an encoded string, and sample ids. Kora does
not rewrite them, since a string is also a valid json value; write the decoded value with
`server.kora.apply` where your app expects an object or array.

## Static files and the offline app shell

The server serves `staticDir` (default `./dist`) the way an offline-first app needs:

| Request | Response |
|---|---|
| Content-hashed file (`assets/index-DrBNyszg.js`) | `Cache-Control: public, max-age=31536000, immutable` |
| Anything else (`index.html`, `sw.js`, `manifest.webmanifest`, the unhashed `assets/sqlite3.wasm`) | `Cache-Control: no-cache`, revalidated with the `ETag` and answered `304` only when the content is unchanged |
| Compressible types (JS, CSS, HTML, JSON, SVG, WASM) | Brotli or gzip per `Accept-Encoding`, with `Vary: Accept-Encoding`. A pre-compressed `file.br` / `file.gz` from your build is used when it decompresses to the file's current bytes; otherwise each file version is compressed once and cached in memory |
| A missing path requested as a **page**: a browser navigation (`Accept: text/html`), or a non-browser client such as a link-preview crawler asking for anything (`Accept: */*` or none, no `Sec-Fetch-Mode`) for an extensionless path outside `/api/` and `/__kora` | `index.html` (the SPA shell), with [per-page metadata](#link-previews-and-per-page-metadata) when `shellMeta` is set |
| Any other missing path, and every missing path under `/assets/` | `404`, so a stale tab asking for an old chunk after a deploy fails loudly instead of parsing HTML as JavaScript |

An app's own `fetch()` of a missing path keeps its 404 (browsers send `Sec-Fetch-Mode` on every
request), and so does any non-browser request under `/api/` or `/__kora`, so a mistyped API path
is a real 404, not an HTML page with status 200. Before beta.15 a crawler asking for `*/*` got a
404 for every app route, so shared links showed no preview; `spaFallback: 'strict'` keeps that
behavior.

A service worker that warms app routes with a plain `fetch('/f/survey')` sends `Accept: */*`
and `Sec-Fetch-Mode`, and therefore gets a 404. Either send the header the browser sends
(`fetch(url, { headers: { Accept: 'text/html' } })`), or set `spaFallback: 'extensionless'`
on `createProductionServer`, which answers every missing path without a file extension (outside
`/assets/`) with the shell.

## Link previews and per-page metadata

Link previews (WhatsApp, Slack, iMessage, LinkedIn, X) and search engines read the HTML the
server sends; they do not run your app's JavaScript. Without help every URL of a single-page app
previews as the same generic card. `shellMeta` writes each URL's own title, description and Open
Graph tags into the shell before it is sent:

```typescript
import { createProductionServer, createSqliteServerStore, metaExcerpt } from '@korajs/server'

const store = createSqliteServerStore({ filename: './kora-server.db' })
const server = createProductionServer({
  store,
  shellMeta: async ({ path, kora }) => {
    const slug = path.match(/^\/f\/([^/]+)/)?.[1]
    if (!slug) return null // the build's index.html as is
    const [form] = await kora.query('forms', {
      where: { slug: decodeURIComponent(slug), status: 'published' },
    })
    if (!form) return null // never describe a draft
    return {
      title: `${form.title} | KoraForms`,
      description: metaExcerpt(String(form.description)), // about 160 characters, cut at a word
      url: `https://forms.example${path}`,
    }
  },
})
```

- `title` sets `<title>`, `og:title` and `twitter:title`; `description` sets the description
  tags; `url` sets `og:url` and the canonical link; `image`, `imageAlt`, `type`, `siteName`,
  `robots` and `tags` (any other `name`/`property` tag) are available too. A tag the shell
  already declares is replaced, never duplicated.
- Values are escaped, so text from user data cannot inject markup.
- It runs whenever the shell is served (the root and every fallback), with the same trusted
  `kora` context as routes. Read only what the page may show publicly: the result is sent to
  anyone who requests the URL.
- Return `null` to serve the build's `index.html` unchanged. A throw is logged and serves it
  unchanged too: metadata never fails a page.
- The rewritten shell is revalidated (`no-cache`) with an ETag of its own bytes and compressed
  per request; offline, the service worker serves its cached shell as before.

Custom routes can also answer HTML (`{ status: 200, html }`) or bytes
(`{ status: 200, raw, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }`), for example
an embed page or `robots.txt`.

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

The relay never leaves a connected requester without an answer. It answers "not held"
once every peer it forwarded the request to has said not held (or disconnected), so one
peer without the chunk cannot preempt a slower one that has it, and when a request
expires unanswered (`blobLimits.pendingRequestTtlMs`, counted from the first time the
request arrived: re-sends under the same id do not extend it, and expiry does not wait
for another message). It answers `throttled` (2 s) when
the session already has `blobLimits.maxPendingRequestsPerSession` requests outstanding
(requests still in the access check count, so a burst cannot overshoot it),
when bytes are ready but the session may not receive them right now (its access rules are
not in force), and when the request id is pending for another session. Warnings are logged
as `blob_relay.pending_cap` and `blob_relay.duplicate_request_id`. A client re-sends an
unanswered request under the same id (re-sent requests are forwarded again, not counted
twice against the cap), and on every reconnect.

## Large grants: the `$in` value limit

<!-- docs-check-prelude
import { createProductionServer, createSqliteServerStore } from '@korajs/server'
import type { AuthProvider, ProductionHttpRouteContext } from '@korajs/server'
const store = createSqliteServerStore({ filename: './kora-server.db' })
const server = createProductionServer({ store })
declare const request: { kora: ProductionHttpRouteContext }
declare const body: { title?: string; notes?: string }
declare const recordId: string
declare const auth: AuthProvider
declare function removeCollaborator(documentId: string, userId: string): Promise<void>
declare const documentId: string
declare const bobId: string
-->

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

An operation after which the record is deleted (a delete, or a write older than the
record's newest delete) is delivered by what each device's view held of the record,
never by the operation's own values. A delete reaches every view in which the record
was live at some point (a retained copy, a retracted one, or one held from an
access-rules membership), even when the record had already left that view. A stale
write that lands on the tombstone is sent only to such a view, and only when its values
are in view, after the record's newest delete (sent once per delivery pass); a view
that never held the record receives nothing, so a stale write cannot make it appear.

The server decides this from a small per-record summary (`kora_record_live_views`):
the distinct values, over the fields the server's own grants read (the auth provider's
scopes before a client narrows them, the schema's declared scope fields and access-rule
read grants; never a client's filters or handshake narrowing), that the record was live
with, and when. Sessions register those fields at
their handshake. A summary is trusted only while the record's fold-state row says it
accounts for the record's newest operation (`lv_through`, written in the same statement
as the fold state by every write that maintains it); a write by any instance that does
not maintain it (an older version during a rolling deploy, a re-fold, a restore) leaves
it unknown until a rebuild, and a later write never makes it current again. A write
that changes neither the record's liveness nor a tracked value touches no summary.
Summaries of existing records, and the tombstone state (`deleted`) of older scope
snapshots, are built by a background backfill after start (short, guarded transactions;
the server serves meanwhile; a replace-mode restore or a snapshot rebuild clears them).
While a record's summary is unknown, a delete is judged on its own values as in
1.0.0-beta.14 (it never reaches a view that did not hold the record), and a write older
than the record's delete is sent as before when its values are in view, after the
record's newest delete: the fold keeps that write's fields (a later revival shows them),
so a device without it would diverge, and the delete keeps the device showing the record
deleted. For an access-rules collection both go only to a member whose membership began
before the record was deleted, judged at the first delete after its last live write (a
later, second delete does not move it): a member who joined after the record was deleted
never receives its stale content. Where that first delete began is read from the stored
tombstone state of the record's newest operations; when that cannot decide it (an
operation written by an older instance that records none, or a longer tombstone), the
record's history is replayed (bounded) and it is decided exactly. A write is never
withheld on a guess, because the delivery watermark would pass it and a member who held
the record would diverge after a revival. If even the replay cannot decide (the lookup
fails, or the history is longer than the bound), the member's stream is held before the
write (its watermark does not advance), the record's summary is rebuilt and the stream is
pushed again; a hold that does not resolve within 15 seconds sends the write as before access rules
applied to it (a client without a delivery watermark, whose stream could not be held, is
refused outright when access rules apply: `CLIENT_TOO_OLD`),
logged as `session.tombstone_delivery_undetermined` at `error` level and emitted as
`server:tombstone-delivery-undetermined`: a narrow disclosure of one stale write to a
current member is accepted over a device that diverges. A snapshot wipe by an older
instance (its fingerprint change) does not bump `live_view_epoch`: the wipe drops the
snapshots' tombstone state and the summaries only, which are then rebuilt, and a rebuild
that read the old log writes nothing the wipe left behind because every summary write is
guarded by the record's current fold state. The snapshot fingerprint is unchanged, so instances of different
versions never rebuild each other's snapshots.

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
- **Browsers that two users shared on beta.12 (a design decision).** beta.12 recorded no
  author per write, only the device's node id, and the database was shared by everyone who
  signed in there. Writes still queued on such a browser therefore upload under the device's
  owner (the user its device id is registered to) once that owner signs in; the other user
  can no longer sign in there (`DEVICE_OWNERSHIP_CONFLICT`). No rule can tell those queued
  writes apart, so holding them would also hold every single-user device's own offline
  edits, which is the common case. From beta.13 on, every write is bound to the signed-in
  user (RT-42), and from beta.14 a user who is still signed in on a browser whose device id
  belongs to someone else (a cached session) cannot write there at all: local writes throw
  `NodeOwnedByAnotherUserError` (`NODE_OWNED_BY_ANOTHER_USER`) instead of being stored under
  the owner's node, where they would later upload as the owner's. The same applies when the
  sync server is the one that knows: a `NODE_ID_CLAIMED` refusal now says whether another
  user owns the node (`nodeOwnership: 'other-principal'`) or it only has ownerless history
  (`'unowned'`), and a store with a pinned node id refuses local writes after the first
  answer until the server accepts the node. With
  `store.namespaceByAuthUser` each user also has their own database. If shared browsers
  matter, have their users sync before the upgrade.

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
process.exit(0) // beta.13's Postgres user store keeps its connection open (beta.14: users.close())
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

### Startup re-materialization (upgrading from beta.12 or changing merge rules)

The first start of a release that introduces or changes how records fold (beta.12 to beta.13 or later, a schema change of a field's merge strategy or kind, new operation transforms, a replace-mode restore) rebuilds every affected record from its operation log inside `store.setSchema(...)`: the record's fold state (`kora_fold_state`), its materialized row and the scope snapshot of each of its operations. Later starts skip records that are already current.

- **Cost is linear in the log.** Each record's operations are folded once, and the per-operation scope snapshots materialize only the scalar fields they keep. Earlier releases (1.0.0-beta.14, and canaries before this fix) materialized every field for the snapshot after every operation, so a `t.richtext()` body (one Yjs merge per stored edit) was re-merged once per operation: quadratic in a document's history. A production database with 25 documents and 11,592 operations took 1,956 s on one laptop core; a single 600-edit document took over 180 s and now takes about 1.5 s.
- **Bounded, resumable transactions.** Records are re-folded in transactions of whole records holding at most 2,000 operations each (a longer record is a transaction of its own). Each transaction holds the delivery-counter lock that every append takes, so on a shared database other instances' writes wait for one batch at most, never for the whole migration. A record's fold state, row and snapshots commit together, so no half-migrated record is visible, and a process that is killed (for example by a startup probe) resumes at the first record still stale instead of starting over. A scope-snapshot rebuild records that it started (`scope_snapshot_fields_pending` in `kora_server_meta`) and likewise resumes at the snapshots still missing.
- **Progress is logged.** A migration that runs longer than 5 seconds prints a line every 5 seconds and a final one:

  ```
  [kora] Fold re-materialization: 1200 / 4800 records done, 1200 rewritten (15 s).
  [kora] Fold re-materialization done: 4800 records, 4800 rewritten, in 61 s.
  ```

- **Know before you deploy.** `kora doctor --db env:DATABASE_URL` reads the production database (read-only) and prints what the next start will re-fold, with a rough duration, and warns when it exceeds 60 seconds. See [kora doctor --db](/api/cli#production-preflight-db).
- **Health checks during the migration.** The migration runs in `store.setSchema(...)`, which the generated `server.ts` awaits before it creates and starts the production server, so `/health` answers once the data plane is ready and sync is never served from a half-migrated store. The server deliberately does not answer `/health` earlier: a probe that passes while the store is migrating would let a platform route sync traffic to an instance that cannot serve it. If your platform's startup probe kills slow starts, give it a budget that covers the first start of an upgrade (the log lines above show how far it is), or raise the probe's failure threshold for the upgrade deploy only. A killed start loses at most the batch in progress.
- **Rich-text writes are incremental.** A server keeps, per rich-text field, the merge of the updates it materialized last (bounded to 64 MiB per process, least recently used first) and merges only what a write adds. The first write to a record after a restart merges its history once. Updates whose Yjs content is incomplete (a delta whose base the server does not hold) are always merged from scratch, so every instance materializes byte-identical values.

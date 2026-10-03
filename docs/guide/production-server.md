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

const server = createProductionServer({
  store: createSqliteServerStore({ filename: './kora-server.db' }),
})

const url = await server.start()
```

## Trusted data-plane access for background jobs

The handle carries a `kora` context: `apply`, `query`, and `findById`. It is the
same object handed to custom HTTP routes as `request.kora`, so a scheduled task
and an HTTP handler share one code path and one set of guarantees. Every mutation
runs through Tier 2 constraints, referential integrity, materialization, and
fan-out to connected clients, which is exactly what writing to the store directly
would skip.

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
beta.13 clients), so a write means the same thing on every path. Route writes are also
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
const server = createProductionServer({
  store,
  syncOptions: {
    maxOperationBytes: 256 * 1024, // reject any single operation larger than 256 KiB
    maxOpsPerMinute: 600,          // sliding-window cap per client
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

## Central blob storage and scheduled garbage collection

When you want blob bytes to outlive the device that authored them, back the
server with a central blob store. `toServerBlobCallbacks` turns any
`ContentAddressedBlobStore` (such as `FilesystemBlobStore`) into the
`resolveBlobChunk` / `persistBlobChunk` pair the sync server needs:

```typescript
import { createProductionServer } from '@korajs/server'
import { FilesystemBlobStore, toServerBlobCallbacks, collectBlobGarbage } from '@korajs/store'

const blobStore = new FilesystemBlobStore('/var/kora/blobs')

const server = createProductionServer({
  store,
  syncOptions: {
    ...toServerBlobCallbacks(blobStore),
  },
})

await server.start()
```

Because blobs are content-addressed and stored out of band, deleting the record
that referenced a blob does not reclaim its bytes. `getLiveBlobRefs()` returns
every reference still reachable from a live record, which is precisely the live
set a mark-and-sweep collector needs. Run it on a schedule:

```typescript
// Reclaim orphaned blob bytes once an hour.
setInterval(async () => {
  const liveRefs = await server.getLiveBlobRefs()
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
retries. Call `server.revalidateSessions()` to run a pass immediately.

The same pass re-resolves each session's sync scopes from the fresh authentication.
When a principal's download or upload scope changed (removed from a team, a role
change), the session is ended with a retriable `SCOPE_CHANGED`; the client
reconnects and is handed its new scope at handshake, so a narrowed grant takes
effect within one revalidation interval rather than at token expiry (RT-26).

## Records moving into a scope (scope entry)

Each operation is delivered according to the scope values its record had right
after that operation was applied (so a new owner never receives the history written
while the record belonged to someone else). When an operation moves an existing
record INTO a session's scope (an ownership transfer, a team change), the server
sends that session a server-built **scope-entry** operation just before it: an
`insert` carrying the record's current values, from the system node
`kora:scope-entry` (sequence 0, deterministic id per triggering operation), stamped
with the record's newest timestamp so it never overrides a field the client wrote
more recently. Clients apply it like any insert (merging per field when they already
hold a stale copy), so the new owner's devices, live or freshly signed in, see the
complete record and can edit it.

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
release) keeps clients without token support working: nodes held by the pre-release
shared anonymous owner, and provisional claims that expired unconfirmed, are
re-issued with a `session.legacy_anonymous_claim` warning in the log. Set it to
`false` once every client is on beta.13 or later.

## Gap-free delivery and the delivery-sequence migration

The server guarantees that once an operation is in its log, it reaches every client whose scope includes it and is never silently skipped, across dropped messages, reconnects, client restarts, and scoped sync. This is driven by a server-assigned delivery sequence and a per-client delivery watermark, and it needs no configuration. The guarantee and its client-side behavior are described in [Sync configuration: delivery guarantees](./sync-configuration.md#delivery-guarantees-server-to-client), and the store methods and wire fields in the [server](../api/server.md#delivery-sequence-gap-free-server-to-client-sync) and [sync](../api/sync.md#protocol-messages) API references.

Two operator notes:

- **First startup after upgrading runs a one-time migration.** Each store adds a `delivery_seq` column and backfills existing operations. This is automatic and idempotent. On a very large Postgres operation log the backfill is a single ordered pass under an advisory lock; it runs once and subsequent startups skip it.
- **Operation scope snapshots and blob owners (beta.13).** Each store adds a nullable `scope_snapshot` column to `operations` and a `blob_owners` table. Download visibility of a historical operation is judged on the record's scope values when that operation was applied, so an ownership transfer does not disclose the earlier history to the new owner, and scope-exit retractions come from the server's own rows. Existing operations are backfilled from the log when the schema is set (one replay per record); operations of collections outside the schema keep the previous behavior. Blob uploads made before the upgrade have no recorded owner: their existing references keep working, and a new reference to such bytes needs the writer to upload them again.
- **Operation log integrity check (beta.14).** On the first start of this release the SQLite and Postgres stores read every stored operation once (keyset pages; Postgres under an advisory lock) and move rows that cannot be read back into an operation (malformed JSON, an out-of-range timestamp) to an `operations_quarantine` table, verbatim, so no materialization ever folds them. A warning is logged when rows move; `store.getLogIntegrityReport()` returns the result. Later starts skip the scan.
- **Postgres serializes delivery-sequence assignment through one counter row** so delivery order matches commit order across instances. This is a deliberate correctness-over-throughput choice and is not a bottleneck for typical sync workloads. If you run a single Postgres at very high sustained write rates and measure contention on it, that is the place to look first.

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

An operation over `maxOperationBytes` is rejected as a permanent
`OPERATION_TOO_LARGE` (the same bytes can never fit). Exceeding `maxOpsPerMinute`
yields a retriable `RATE_LIMIT` (the client should back off and resend). Both
defaults (256 KiB and 600 ops/min) apply when you omit the knobs.

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

## Gap-free delivery and the delivery-sequence migration

The server guarantees that once an operation is in its log, it reaches every client whose scope includes it and is never silently skipped, across dropped messages, reconnects, client restarts, and scoped sync. This is driven by a server-assigned delivery sequence and a per-client delivery watermark, and it needs no configuration. The guarantee and its client-side behavior are described in [Sync configuration: delivery guarantees](./sync-configuration.md#delivery-guarantees-server-to-client), and the store methods and wire fields in the [server](../api/server.md#delivery-sequence-gap-free-server-to-client-sync) and [sync](../api/sync.md#protocol-messages) API references.

Two operator notes:

- **First startup after upgrading runs a one-time migration.** Each store adds a `delivery_seq` column and backfills existing operations. This is automatic and idempotent. On a very large Postgres operation log the backfill is a single ordered pass under an advisory lock; it runs once and subsequent startups skip it.
- **Postgres serializes delivery-sequence assignment through one counter row** so delivery order matches commit order across instances. This is a deliberate correctness-over-throughput choice and is not a bottleneck for typical sync workloads. If you run a single Postgres at very high sustained write rates and measure contention on it, that is the place to look first.

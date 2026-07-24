---
"@korajs/server": minor
---

The production server handle now exposes the data plane it already owns, so
background jobs and scheduled tasks no longer have to reach past it.

`server.kora` gives server-side callers `apply`, `query`, and `findById` through
the exact validated pipeline sync uses (Tier 2 constraints, referential
integrity, materialization, and fan-out to connected clients), with no HTTP
request needed. It is the same context custom HTTP routes receive as
`request.kora`, so a job and a request share one code path.

`server.getLiveBlobRefs()` returns every blob reference still reachable from a
live record, which is the live set for a scheduled mark-and-sweep: pair it with
`collectBlobGarbage` from `@korajs/store` to reclaim orphaned central blob bytes.

`maxOperationBytes` and `maxOpsPerMinute` are now settable on
`KoraSyncServerConfig` (and therefore via `createProductionServer({ syncOptions })`),
so one payload-size cap and one per-client rate cap apply to every connected
session instead of being configured session by session.

Every apply rejection now carries a `retriable` flag through a single shared
taxonomy (`OperationRejection`, `isRetriableRejection`): `true` for transient
conditions like a rate limit, `false` for permanent ones like a constraint or
referential conflict. This is the same `retriable` flag the sync protocol already
sends clients on the wire, so server-side callers and remote clients read one
classification. See the new "Production server" guide for the central-blob +
scheduled-GC example.

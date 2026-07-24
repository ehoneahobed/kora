---
"@korajs/core": minor
"@korajs/sync": minor
"@korajs/server": minor
"korajs": minor
---

Server-side adjudication of untrusted client operations before they become
authoritative. This is what lets Kora serve public and multi-tenant offline apps
where the client cannot be trusted (anonymous form submissions, one tenant that
must not write another's data).

Pass `validateOperation` in the server's `syncOptions` (or to `KoraSyncServer`).
It runs at sync ingestion, after HLC ordering and the built-in guards, and before
materialization, returning `accept`, `reject`, or `ignore`. On `reject` the
operation never enters the authoritative log, so no other replica ever sees it,
and a structured rejection travels back to the submitter tied to the operation id.
The validator receives an `auth` context (null for anonymous connections) and the
trusted `kora` data-plane, so it can read current state and author a derived
server operation — for example promoting a validated anonymous submission into an
owner-visible collection.

On the client, a rejected operation is diverted out of the pending outbound queue
into a durable rejected store (`_kora_sync_rejected`, survives a page refresh)
rather than being retried forever or lost on the batch ack, and a
`sync:operation-rejected` event fires. `app.sync.getRejectedOperations()` and
`app.sync.clearRejectedOperations()` let the app surface failed submissions and
reconcile (roll back the optimistic write or resubmit). Convergence holds: the
authoritative state is defined purely by accepted operations, so every synced
device agrees without the rejected op, and the submitter is told rather than
diverging silently. See the new "Server-side operation validation" guide.

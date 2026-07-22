---
"@korajs/server": minor
---

Add a scoped, validated data-plane context to custom HTTP routes (`request.kora`).

`httpRoutes` handlers now receive a `kora` context on the request so server-side REST endpoints stop bypassing the guarantees the sync path enforces:

- `kora.apply(mutation, { scope })` builds a server-originated operation and runs it through the same pipeline as sync — Tier 2 constraint validation, referential integrity and cascade side effects, materialization, and fan-out to connected clients. When a `scope` is supplied, a mutation whose resulting record falls outside it is rejected with `SCOPE_VIOLATION` instead of being written.
- `kora.query(collection, { scope, ...options })` and `kora.findById(collection, id, { scope })` read materialized state and, when a scope is supplied, only return records inside it.
- Mutations are serialized so concurrent requests cannot race on server sequence-number allocation.

`KoraSyncServer` gains a public `applyLocalOperation(op)` that applies a server-originated operation through the validated pipeline and relays it to connected clients (each session still applies its own per-scope visibility filter). Previously the only way to create data from a REST handler was to write to the store directly, which skipped constraints, referential integrity, scope, and live fan-out.

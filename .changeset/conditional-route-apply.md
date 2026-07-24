---
"@korajs/server": minor
---

Add `applyConditional` to the production route context: a conditional,
multi-collection admission gate for custom HTTP routes.

`request.kora.applyConditional({ collection, id, if, update, also, reject,
idempotencyKey })` reads the target record, evaluates the `if` predicate against
its current materialized state, and only then applies the `update` to the target
plus every mutation in `also` as one set. When the predicate fails it applies
nothing and returns the structured `reject`. `idempotencyKey` names a record whose
prior existence proves the set already committed, so a retry returns the earlier
outcome instead of re-running non-idempotent counter increments. The predicate
language (`$eq`, `$ne`, `$lt`, `$lte`, `$gt`, `$gte`, `$in`) is exported as
`RoutePredicate`.

This also fixes the route `apply` path to resolve atomic-op sentinels
(`op.increment`, `op.max`, ...): `data` now carries the concrete resolved value
and the operation carries the atomic intent, so server-authored atomic writes
compose in the merge engine exactly like client writes instead of being stored as
raw sentinel objects.

The whole mutation set is built and scope-validated before any of it is committed,
so a malformed mutation or scope violation in `also` cannot leave the target update
(for example a counter increment) committed while the rest is rejected.

Within one server instance the check and writes do not interleave with other route
mutations. Cross-instance race-free admission and all-or-nothing across a mid-set
crash require a store-level conditional transaction (a Postgres `WHERE ... < cap`
commit with row locking), which is a follow-up that needs a live-Postgres
integration environment to certify.

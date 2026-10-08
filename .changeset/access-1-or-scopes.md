---
"@korajs/core": minor
"@korajs/sync": minor
"@korajs/server": minor
"@korajs/store": minor
---

Scope grants may be disjunctive: a collection scope is a conjunction of field predicates or `{ $or: [conjunction, ...] }` (up to 8 branches), so "my own records OR records in spaces I belong to" is one grant. Every decision (delivery, live relay, scope snapshots, uploads, reference checks, route queries, presence partition keys, the client's upload pre-check and local scope narrowing) goes through one matcher in `@korajs/core`, which fails closed on any malformed scope. Equivalent grants normalize to one canonical form; a handshake can only narrow each branch. First step of the beta.15 access rules.

Clients now declare `supportsScopeDisjunction` at handshake. A server refuses a client that does not (Kora beta.14 and earlier) with `CLIENT_TOO_OLD` when its resolved grant contains a disjunction, because an older client would read `$or` as a field name and treat every record as outside its scope. Grants without `$or` are unaffected.

A grant whose field predicate is an object other than exactly `{ $in: [...] }` (for example `{ $in: [...], $ne: ... }` or `{ $ne: ... }`) is now refused at handshake (`SCOPE_PREDICATE_LIMIT`) instead of being normalized to its `$in` part.

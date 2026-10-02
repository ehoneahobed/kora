# Phase 1 red-team review, round 3 (2026-10-02)

A fresh reviewer ran against HEAD d21a8e4, after the round-2 fixes. Every round-2 security fix held against variant exploits. The main findings are regressions in legitimate offline-first flows, tracked as RT-19..RT-26.

- **RT-19 (R1), High.** A record moving into scope never appears for its new owner. Visibility is judged on `snapshot.post` (`client-session.ts:1993`), so only the scope-changing update is delivered, and the client drops an update for a record it doesn't have.
  - Fix: on a pre-out/post-in transition, send a synthesized scope-entry insert built from the current materialized row, before the update.
- **RT-20 (R2), High.** Scope snapshots are only backfilled where NULL (memory, `sqlite:311`, `postgres:494`). A schema change that adds or renames a scope field hides history from fresh devices.
  - Fix: recompute snapshots when the scoping field set changes, or fall back to the current row when the field is absent (still fail closed when it is present and mismatched).
- **RT-21 (R3), Medium.** An anonymous node token lost between claim commit and client persist means permanent lockout. Legacy anonymous clients and claims made under the old shared owner are also locked out.
  - Fix: two-phase (provisional) claim, client node-id rotation with re-enqueue on `NODE_ID_CLAIMED`, and a grace path for one release.
- **RT-22 (R4), Medium.** Foreign-key targets are checked against the downlink scope only (`reference-authorization.ts:75`), so children of write-only parents are rejected.
  - Fix: accept a parent in the writer's uplink OR downlink scope.
- **RT-23 (R5), Medium.** In peer-relay mode, possession is never recorded (`client-session.ts:1024`), so identical content in a second tenant is rejected forever.
  - Fix: record hash-verified possession on push without storing the bytes, or gate at serve time only.
- **RT-24 (R6), Low-Medium.** Blob requests share the operation rate limit, and "not held" is treated as a hard failure (`blob-transfer.ts:82`).
  - Fix: separate budget, plus a retriable throttle signal with backoff.
- **RT-25 (S1), Low-Medium.** A bare reference claims an unowned hash. That creates an existence oracle and lets a pre-claimer later read bytes another tenant uploads (`blob-access-index.ts:147-157`).
  - Fix: require proof of possession to claim (central mode), and serve from the store only to owners who pushed.
- **RT-26 (S2), Info.** Revalidation compares identity only, so a scope or role change applies at token expiry.
  - Fix: compare resolved scopes, or document the behaviour.

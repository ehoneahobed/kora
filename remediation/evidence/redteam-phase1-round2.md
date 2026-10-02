# Phase 1 red-team review, round 2 (2026-10-01)

A fresh reviewer re-attacked the branch after the RT-1..RT-10 fixes. Round-1 fixes held against variant exploits (see the coverage list in the session record). The new findings below are tracked as RT-11..RT-18.

- **RT-11 (F1), Medium-High.** Blob gate bypass by reference forging. Uplink authorization does not check the hashes a blob field points at, so writing `{owner:self, doc:{hash:H}}` grants read access to H. The same trick makes the forwarding check pass. Locations: `blob-access-index.ts:99-121`, `kora-sync-server.ts:1091-1115`.
  - Fix: at ingest, accept a blob ref only if the hash is already referenced inside the writer's downlink scope, or the session itself pushed the bytes (record `blob_owner(hash, partition)` on push). Document that a content hash is not a secret.
- **RT-12 (F2), Medium.** Anonymous node-id hijack. All anonymous principals share the claim owner `kora:anonymous`. A forged high sequence then makes the victim's `collectDelta` skip its queued writes (silent loss). A provider issuing `userId 'kora:anonymous'` collides with that owner. Location: `client-session.ts:980`.
  - Fix: per-device node token issued at first claim and required on reconnect; reserve the `kora:` prefix.
- **RT-13 (F3), Medium.** Dangling child across tenants. Inserts do not authorize foreign-key targets, so the parent's owner gets RESTRICTED forever. Location: `apply-server-operation.ts:112-145`.
  - Fix: the referenced parent must exist in the writer's downlink scope, else `SCOPE_VIOLATION`.
- **RT-14 (F4), Low-Medium.** An ownership transfer discloses the full edit history, because historical ops are judged on the current row (`client-session.ts:1729-1749`, delta `:1504`).
  - Fix: stamp scope values onto ops at ingest and judge history per op.
- **RT-15 (F5), Low.** Retraction injection via writer `previousData` (`server-scope-filter.ts:100-117`).
  - Fix: build pre-images from server rows.
- **RT-16 (F6), Low.** Directional uplink grants skip `resolveSessionScopes` (`client-session.ts:1055-1057`). Fails closed.
- **RT-17 (F7), Low.** Blob requests are not rate-limited, and each write triggers full scope rescans.
- **RT-18.** Revocation listeners are in-process only; other instances keep sessions until token expiry.

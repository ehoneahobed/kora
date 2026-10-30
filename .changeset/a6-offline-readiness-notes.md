---
"korajs": patch
"@korajs/auth": patch
"@korajs/store": patch
"@korajs/cli": patch
---

New guide, [Offline Readiness](https://korajs.dev/guide/offline-readiness): what Kora guarantees (a `ready` app opens offline, a write whose promise resolved is never lost) and what the app is responsible for, with `app.offline.status()`, `keep`, the app shell and `<OfflineBadge />`, offline sign-in, storage-loss reporting and durable writes on the IndexedDB fallback.

Upgrade notes for `1.0.0-beta.15`:

- Update `korajs`, `@korajs/auth` and `@korajs/cli` together. An older `@korajs/auth` cannot report offline sign-in (`auth-unknown`, never `ready`); an older `@korajs/cli` plugin publishes no shell status (`shell-none`).
- A custom `AuthTokenStorage` that does not declare `durability` reads as `unknown` and is never `ready`. Pass `durability: 'durable'` to `createAuthTokenStorage` for a store that survives a restart, or declare `offline.auth`.
- A custom `ContentAddressedBlobStore` that does not declare `durable` counts as not durable: a pin that keeps files reports `storage-non-durable`. Declare `readonly durable = true` on a store whose bytes survive a restart.
- On the IndexedDB fallback a write can now reject with `WriteNotDurableError` (it used to resolve even when its snapshot failed). The write exists; do not retry it.
- An app with a bare `sync.auth` token function reads `not-ready` until it declares `offline.auth`.

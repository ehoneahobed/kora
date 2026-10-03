---
title: API Reference
description: "API reference for every Kora.js package: core, store, merge, sync, server, auth, react, vue, svelte, devtools, test, the CLI and error codes."
---

# API Reference

Kora.js is a set of focused packages. Each owns one layer of the offline-first stack.

## Which packages do I need?

| You are building | Install (with the `@beta` tag) |
|------------------|--------------------------------|
| A React app | `korajs`, `@korajs/react` |
| A Vue or Svelte app | `korajs`, `@korajs/vue` or `@korajs/svelte` |
| A sync server | `@korajs/server` |
| Sign-in, organizations, MFA | `@korajs/auth` |
| A Tauri desktop app | `@korajs/tauri` in addition |
| Sync tests | `@korajs/test` (dev dependency) |

`korajs` gives you `createApp`, `defineSchema`, `t`, `migrate`, `op` and the types you write apps
with; it depends on `@korajs/core`, `@korajs/store`, `@korajs/merge`, `@korajs/sync` and
`@korajs/devtools`. `create-kora-app` sets all of this up.

## Packages

```
korajs               The app API (createApp, defineSchema, t, op, types)
  @korajs/core       Schema, types, operations, hybrid logical clock, the record fold
  @korajs/store      Local storage (SQLite WASM on OPFS, IndexedDB, native SQLite), queries
  @korajs/merge      Constraint and referential checks; the deprecated pairwise merge
  @korajs/sync       Sync engine, protocol v2, transports, encryption keyring, presence
  @korajs/devtools   Instrumentation, the DevTools panel and overlay
@korajs/server       Self-hosted sync server
@korajs/auth         Authentication, sessions, MFA, organizations, RBAC
@korajs/react        React bindings
@korajs/vue          Vue bindings
@korajs/svelte       Svelte bindings
@korajs/tauri        Native SQLite for Tauri desktop apps
@korajs/test         In-process multi-device sync tests
@korajs/cli          The kora command (create, dev, migrate, deploy, studio, ...)
create-kora-app      npx entry point of `kora create`
```

## Reference pages

| Page | Contents |
|------|----------|
| [Core](/api/core) | `defineSchema`, field builders, atomic ops, the HLC, operations, the fold, version vectors, scopes, migrations, blobs |
| [Store](/api/store) | Collections, queries, subscriptions, transactions, sequences, adapters, blobs |
| [Merge](/api/merge) | Constraint checks, referential integrity, rich-text helpers |
| [Sync](/api/sync) | `app.sync`, status types, `SyncEngine`, transports, protocol constants, encryption, presence |
| [Server](/api/server) | `createProductionServer`, `KoraSyncServer`, stores, the route context, auth providers, validation |
| [Auth](/api/auth) | Auth client, sync binding, passkeys, the auth server, sessions, MFA, organizations, RBAC, OAuth |
| [React](/api/react) | `KoraProvider`, `createKoraHooks`, `useQuery`, `useMutation`, `useSyncStatus`, rich text, presence |
| [Vue](/api/vue) / [Svelte](/api/svelte) | The same bindings for Vue and Svelte |
| [DevTools](/api/devtools) | The complete event catalog, `Instrumenter`, panel building blocks |
| [Test](/api/test) | `createTestNetwork`, `TestDevice`, `TestServer`, convergence assertions |
| [CLI](/api/cli) | Every `kora` command and flag |
| [Error Codes](/api/errors) | Every error code with its cause and fix |

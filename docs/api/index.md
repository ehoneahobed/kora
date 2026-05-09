# API Reference

Kora.js is organized as a monorepo of focused packages. Each package owns a specific layer of the offline-first stack.

## Which packages do I need?

**Most developers need only two packages:**

| Package | Purpose |
|---------|---------|
| `kora` | Meta-package that re-exports everything from core, store, merge, and sync |
| `@korajs/react` | React hooks and bindings |

The `kora` meta-package gives you `createApp`, `defineSchema`, `t`, and all the primitives you need to build an offline-first application. The `@korajs/react` package adds reactive hooks for your UI layer.

If you are building a self-hosted sync server, you also need `@korajs/server`.

## Package architecture

```
kora                        Meta-package (re-exports core, store, merge, sync)
  @korajs/core                Schema, operations, clocks, types
  @korajs/store               Local storage (SQLite WASM, IndexedDB)
  @korajs/merge               Three-tier conflict resolution
  @korajs/sync                Sync protocol and transports
@korajs/server                Self-hosted sync server
@korajs/auth                  Authentication, sessions, MFA, RBAC
@korajs/react                 React hooks and bindings (incl. presence)
@korajs/devtools              Browser DevTools extension
@korajs/test                  Testing harness for offline-first apps
@korajs/tauri                 Native SQLite for Tauri desktop apps
@korajs/cli                   CLI tooling, scaffolding, and deployment
```

## Dependency graph

```
@korajs/core       -> (no @kora dependencies)
@korajs/store      -> @korajs/core
@korajs/merge      -> @korajs/core
@korajs/sync       -> @korajs/core, @korajs/merge
@korajs/server     -> @korajs/core, @korajs/sync
@korajs/react      -> @korajs/core, @korajs/store, @korajs/sync
@korajs/devtools   -> @korajs/core
@korajs/cli        -> (all packages)
```

## Reference pages

| Page | Contents |
|------|----------|
| [Core](/api/core) | `defineSchema`, `t` type builders, `HybridLogicalClock`, `Operation`, state machines, migration rollbacks, protobuf codegen |
| [Store](/api/store) | Collection methods (`insert`, `update`, `delete`, `where`, `subscribe`), state machine validation, bloom filter subscriptions |
| [Merge](/api/merge) | `MergeEngine`, strategies, constraint checking, referential integrity, state machine merge resolution |
| [Sync](/api/sync) | `SyncEngine`, transports, E2E encryption, diagnostics/metrics, awareness/presence, scope filtering |
| [Server](/api/server) | `createKoraServer`, server stores (Memory, Postgres, SQLite), auth providers, awareness relay |
| [Auth](/api/auth) | `AuthClient`, `BuiltInAuthRoutes`, `TokenManager`, sessions, MFA, orgs, RBAC, passkeys |
| [React](/api/react) | `KoraProvider`, `useQuery`, `useMutation`, `useSyncStatus`, `usePresence`, `useCollaborators`, `useRichText` |
| [DevTools](/api/devtools) | `Instrumenter`, `EventBuffer`, `MessageBridge`, filtering, panel state |
| [Test](/api/test) | `createTestNetwork`, `TestDevice`, `TestServer`, `expectConverged`, `ChaosTransport` |
| [CLI](/api/cli) | `kora create`, `kora dev`, `kora migrate`, `kora generate`, `kora deploy` |

## Imports

The `kora` meta-package re-exports the most commonly used symbols:

```typescript
// Most developers only need this
import { createApp, defineSchema, t } from 'korajs'
import { KoraProvider, useQuery, useMutation, useSyncStatus } from '@korajs/react'
```

For advanced use cases, import directly from the specific package:

```typescript
import { HybridLogicalClock, createOperation } from '@korajs/core'
import { Store } from '@korajs/store'
import { MergeEngine } from '@korajs/merge'
import { SyncEngine, WebSocketTransport } from '@korajs/sync'
import { createKoraServer } from '@korajs/server'
```

# API Reference

Kora.js is organized as a monorepo of focused packages. Each package owns a specific layer of the offline-first stack.

## Which packages do I need?

**Most developers need only two packages:**

| Package | Purpose |
|---------|---------|
| `kora` | Meta-package that re-exports everything from core, store, merge, and sync |
| `@kora/react` | React hooks and bindings |

The `kora` meta-package gives you `createApp`, `defineSchema`, `t`, and all the primitives you need to build an offline-first application. The `@kora/react` package adds reactive hooks for your UI layer.

If you are building a self-hosted sync server, you also need `@kora/server`.

## Package architecture

```
kora                        Meta-package (re-exports core, store, merge, sync)
  @kora/core                Schema, operations, clocks, types
  @kora/store               Local storage (SQLite WASM, IndexedDB)
  @kora/merge               Three-tier conflict resolution
  @kora/sync                Sync protocol and transports
@kora/server                Self-hosted sync server
@kora/react                 React hooks and bindings
@kora/devtools              Browser DevTools extension
@kora/cli                   CLI tooling and scaffolding
```

## Dependency graph

```
@kora/core       -> (no @kora dependencies)
@kora/store      -> @kora/core
@kora/merge      -> @kora/core
@kora/sync       -> @kora/core, @kora/merge
@kora/server     -> @kora/core, @kora/sync
@kora/react      -> @kora/core, @kora/store, @kora/sync
@kora/devtools   -> @kora/core
@kora/cli        -> (all packages)
```

## Reference pages

| Page | Contents |
|------|----------|
| [Core](/api/core) | `defineSchema`, `t` type builders, `HybridLogicalClock`, `Operation`, `HLCTimestamp`, `MergeTrace`, `KoraError` |
| [Store](/api/store) | Collection methods (`insert`, `update`, `delete`, `where`, `subscribe`), `StorageAdapter` interface, query builder |
| [Server](/api/server) | `createKoraServer`, server stores (Memory, Postgres, SQLite), auth providers, transports |
| [React](/api/react) | `KoraProvider`, `useQuery`, `useMutation`, `useSyncStatus`, `useCollection`, `useRichText` |
| [CLI](/api/cli) | `kora create`, `kora dev`, `kora migrate`, `kora generate` |

## Imports

The `kora` meta-package re-exports the most commonly used symbols:

```typescript
// Most developers only need this
import { createApp, defineSchema, t } from 'kora'
import { KoraProvider, useQuery, useMutation, useSyncStatus } from '@kora/react'
```

For advanced use cases, import directly from the specific package:

```typescript
import { HybridLogicalClock, createOperation } from '@kora/core'
import { Store } from '@kora/store'
import { MergeEngine } from '@kora/merge'
import { SyncEngine, WebSocketTransport } from '@kora/sync'
import { createKoraServer } from '@kora/server'
```

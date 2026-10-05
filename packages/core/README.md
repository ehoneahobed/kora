# @korajs/core

Schema definitions, type inference, operations, the hybrid logical clock, version vectors and the record fold (the per-field merge every replica runs) for Kora.js. It is the foundation: every other package depends on it.

> Most developers don't install this directly. Use [`korajs`](https://www.npmjs.com/package/korajs) instead.

## Install

```bash
pnpm add @korajs/core@beta
```

## Usage

### Define a Schema

```typescript
import { defineSchema, t } from '@korajs/core'

const schema = defineSchema({
  version: 1,
  collections: {
    todos: {
      fields: {
        title: t.string(),
        completed: t.boolean().default(false),
        tags: t.array(t.string()).default([]),
        notes: t.richtext().optional(),
        priority: t.enum(['low', 'medium', 'high']).default('medium'),
        createdAt: t.timestamp().auto(),
      },
      indexes: ['completed'],
    },
  },
})
```

### Hybrid Logical Clock

```typescript
import { HybridLogicalClock } from '@korajs/core'

const clock = new HybridLogicalClock('node-1')

const ts1 = clock.now()
const ts2 = clock.now()

// Timestamps are always monotonically increasing
HybridLogicalClock.compare(ts1, ts2) // negative (ts1 < ts2)

// Merge a remote timestamp (rejected, without changing the clock, if malformed or
// more than 5 minutes in the future)
const ts3 = clock.receive({ wallTime: ts2.wallTime + 5, logical: 0, nodeId: 'node-2' })
```

### Version Vectors

```typescript
import { computeDelta, mergeVectors, type Operation, type VersionVector } from '@korajs/core'

declare const localVector: VersionVector
declare const remoteVector: VersionVector
declare const log: { getRange(nodeId: string, from: number, to: number): Promise<Operation[]> }

const merged = mergeVectors(localVector, remoteVector)
const missing = await computeDelta(localVector, remoteVector, log) // causal order
```

## What's Inside

- **Schema system**: `defineSchema`, `t` field builders, full TypeScript type inference
- **Operation type**: immutable, content-addressed mutation records
- **Hybrid Logical Clock**: causal ordering without synchronized clocks
- **Version vectors**: delta computation for uploads
- **Record fold**: `foldRecord`, `mergeOp`, `materialize`, `joinStates`: one deterministic per-field CRDT
- **Atomic ops**: `op.increment`, `op.append` and friends
- **Migrations**: `migrate()` builders for schema versions
- **Error types**: structured `KoraError` base class with codes

## License

MIT

See the [Core API reference](https://korajs.dev/api/core) and the [guides](https://korajs.dev).

# @korajs/core

Schema definitions, operations, Hybrid Logical Clock, version vectors, and type inference for Kora.js. This is the foundation package -- all other packages depend on it.

> Most developers don't install this directly. Use [`korajs`](https://www.npmjs.com/package/korajs) instead.

## Install

```bash
pnpm add @korajs/core
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
        notes: t.richtext(),
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

// Merge with a remote timestamp
const ts3 = clock.receive(remoteTimestamp)
```

### Version Vectors

```typescript
import { mergeVectors, deltaOperations } from '@korajs/core'

const merged = mergeVectors(localVector, remoteVector)
const missing = deltaOperations(localVector, remoteVector, operationLog)
```

## What's Inside

- **Schema system** -- `defineSchema`, `t` field builders, full TypeScript type inference
- **Operation type** -- immutable, content-addressed mutation records
- **Hybrid Logical Clock** -- causal ordering without synchronized clocks
- **Version vectors** -- efficient delta sync computation
- **Error types** -- structured `KoraError` base class

## License

MIT

See the [full documentation](https://github.com/ehoneahobed/kora) for guides, API reference, and examples.

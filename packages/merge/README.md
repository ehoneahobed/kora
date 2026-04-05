# @korajs/merge

Three-tier conflict resolution engine for Kora.js. Handles concurrent modifications across offline devices and produces deterministic, commutative merge results.

> Most developers don't install this directly. Use [`korajs`](https://www.npmjs.com/package/korajs) instead.

## Install

```bash
pnpm add @korajs/merge
```

## How It Works

The merge engine resolves conflicts in three tiers:

**Tier 1 -- Auto-Merge (default for all fields):**
- `string`, `number`, `boolean`, `enum`, `timestamp` -- Last-Write-Wins via HLC
- `array` -- Add-wins set (union of elements)
- `richtext` -- Yjs CRDT (character-level merge)

**Tier 2 -- Constraint Validation:**
After auto-merge, constraints (unique, capacity, referential) are checked. Violations trigger the configured `onConflict` strategy.

**Tier 3 -- Custom Resolvers:**
For domain-specific logic that neither auto-merge nor constraints can handle.

## Usage

```typescript
import { MergeEngine } from '@korajs/merge'

const engine = new MergeEngine({ schema })

// Merge two concurrent operations
const result = engine.merge(localOperation, remoteOperation)

// result.value   -- the resolved value
// result.trace   -- full MergeTrace for debugging/DevTools
// result.tier    -- which tier resolved it (1, 2, or 3)
```

### Custom Resolver

```typescript
const schema = defineSchema({
  collections: {
    inventory: {
      fields: {
        productId: t.string(),
        quantity: t.number(),
      },
      resolve: {
        quantity: (local, remote, base) => {
          // Additive merge: apply both deltas
          const localDelta = local - base
          const remoteDelta = remote - base
          return Math.max(0, base + localDelta + remoteDelta)
        },
      },
    },
  },
})
```

## Guarantees

- **Deterministic** -- same operations always produce the same result
- **Commutative** -- `merge(A, B)` equals `merge(B, A)`
- **Idempotent** -- applying the same operation twice has no additional effect
- **Traceable** -- every decision produces a `MergeTrace` for inspection

## License

MIT

See the [full documentation](https://github.com/ehoneahobed/kora) for guides, API reference, and examples.

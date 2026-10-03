# @korajs/merge

Cross-record rules for Kora.js: constraint checks (unique, capacity, referential), referential
integrity on delete, and rich-text helpers.

> Most apps do not install this directly. Records are merged by the per-field fold in
> `@korajs/core` on every device and server; `createApp` and the sync server wire this package.

## Install

```bash
pnpm add @korajs/merge@beta
```

## How Kora merges

Since 1.0.0-beta.13 every replica computes a record from its operations with one deterministic
per-field CRDT (the fold in `@korajs/core`), so the result depends only on the set of operations,
not their order or duplicates:

- strings, numbers, booleans, enums, timestamps: the later write wins (hybrid logical clock)
- arrays: an element set (concurrent additions and removals both apply)
- objects: per top-level key
- rich text: Yjs, character by character
- `.merge('counter' | 'max' | 'min' | 'append-only' | 'server-authoritative')` and custom
  `resolve` functions where declared

Constraints span records, so the **sync server** enforces them: a violating operation is refused,
and races are corrected with deterministic server operations.

<!-- docs-check: standalone -->
```typescript
import { defineSchema, t } from 'korajs'

export const schema = defineSchema({
  version: 1,
  collections: {
    inventory: {
      fields: {
        sku: t.string(),
        quantity: t.number().merge('counter'), // concurrent changes add up
      },
      constraints: [{ type: 'unique', fields: ['sku'], onConflict: 'first-write-wins' }],
    },
  },
})
```

`MergeEngine` and the pairwise strategy functions implement the 1.0.0-beta.12 merge. They remain
only for `experimental.legacyMerge` in this release and will be removed.

## Documentation

[Conflict Resolution](https://korajs.dev/guide/conflict-resolution) and the
[Merge API reference](https://korajs.dev/api/merge).

## License

MIT

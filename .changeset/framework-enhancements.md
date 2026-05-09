---
"@korajs/core": minor
"@korajs/store": minor
"@korajs/merge": minor
"@korajs/sync": minor
"@korajs/server": minor
"@korajs/react": minor
"korajs": minor
"@korajs/test": minor
---

Add framework enhancements: atomic field operations, schema-level merge strategies, transactions, sequences, sync scopes, schema migrations, and testing harness

**New features:**
- `op.increment()`, `op.decrement()`, `op.max()`, `op.min()`, `op.append()`, `op.remove()` — atomic field operations that prevent lost updates
- `t.number().merge('counter')`, `.merge('max')`, `.merge('min')`, `t.array().merge('append-only')`, `.merge('server-authoritative')` — schema-level merge strategies
- `app.transaction()` and `app.mutation()` — atomic multi-collection operations
- `app.sequences.next()`, `.current()`, `.reset()` — offline-safe formatted sequence generation
- `buildScopeMap()` — sync scope computation from schema
- `migrate()` / `MigrationBuilder` — programmatic schema migration builder
- `@korajs/test` — testing harness with `createTestNetwork()`, `TestDevice`, `expectConverged()`

**Fixes:**
- Resolved all biome lint errors across the entire codebase

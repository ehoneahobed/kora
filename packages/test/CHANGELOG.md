# @korajs/test

## 0.4.0

### Minor Changes

- ff155cd: Add framework enhancements and 9 completeness features

  **Phase 1-5 features:**

  - `op.increment()`, `op.decrement()`, `op.max()`, `op.min()`, `op.append()`, `op.remove()` — atomic field operations
  - `t.number().merge('counter')`, `.merge('max')`, `.merge('min')`, `t.array().merge('append-only')`, `.merge('server-authoritative')` — schema-level merge strategies
  - `app.transaction()` and `app.mutation()` — atomic multi-collection operations
  - `app.sequences.next()`, `.current()`, `.reset()` — offline-safe formatted sequences
  - `buildScopeMap()` — sync scope computation from schema
  - `migrate()` / `MigrationBuilder` — programmatic schema migration builder
  - `@korajs/test` — testing harness with `createTestNetwork()`, `TestDevice`, `expectConverged()`

  **Framework completeness features:**

  - E2E sync encryption (AES-256-GCM, PBKDF2 key derivation)
  - Bloom filter subscription optimization for high-volume reactive queries
  - Referential integrity enforcement during merge (cascade, set-null, restrict)
  - Sync diagnostics and metrics (bandwidth estimation, RTT tracking, percentiles)
  - Migration rollbacks with auto-generated inverse steps
  - Sync scope filtering for operation-level access control
  - State machine constraints on enum fields with `.transitions()` API
  - Awareness/presence protocol with `usePresence()` and `useCollaborators()` React hooks
  - Protobuf code generation from schema definitions

  **Fixes:**

  - Resolved all biome lint errors across the entire codebase

### Patch Changes

- Updated dependencies [ff155cd]
  - @korajs/core@0.4.0
  - @korajs/store@0.4.0
  - @korajs/merge@0.4.0
  - @korajs/sync@0.4.0
  - @korajs/server@0.4.0

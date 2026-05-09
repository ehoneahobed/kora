# Kora.js Changelog

## 0.4.0

### New Features

- **E2E Sync Encryption** -- AES-256-GCM encryption with PBKDF2 key derivation for end-to-end encrypted sync
- **State Machine Constraints** -- Enum fields support `.transitions()` to declare allowed state changes, enforced during mutations and merge
- **Migration Rollbacks** -- Auto-generated inverse migration steps with `canAutoRollback()` and explicit `.down()` support
- **Referential Integrity in Merge** -- Concurrent delete/insert conflicts resolved via `onDelete` policies (cascade, set-null, restrict)
- **Sync Diagnostics & Metrics** -- Real-time bandwidth estimation, RTT percentiles, and operation counters
- **Awareness/Presence Protocol** -- Ephemeral collaborative state with `usePresence()` and `useCollaborators()` hooks
- **Bloom Filter Subscriptions** -- Optimized subscription invalidation using bloom filters for high-volume reactive queries
- **Sync Scope Filtering** -- `operationMatchesScope()` and `filterOperationsByScope()` for operation-level access control
- **Protobuf Code Generation** -- `generateProtoDefinitions(schema)` generates `.proto` definitions from your schema

### Phase 1-5 Features (0.3.x)

- **Atomic Field Operations** -- `op.increment()`, `op.decrement()`, `op.max()`, `op.min()`, `op.append()`, `op.remove()`
- **Schema-Level Merge Strategies** -- `.merge('counter')`, `.merge('max')`, `.merge('min')`, `.merge('append-only')`, `.merge('server-authoritative')`
- **Transactions** -- `app.transaction()` and `app.mutation()` for atomic multi-collection operations
- **Sequences** -- `app.sequences.next()` for offline-safe formatted ID generation
- **Schema Migrations** -- `migrate()` builder with addField, removeField, renameField, addIndex, removeIndex, backfill
- **Testing Harness** -- `@korajs/test` with `createTestNetwork()`, `TestDevice`, `expectConverged()`

## 0.1.0

### Minor Changes

- Initial release

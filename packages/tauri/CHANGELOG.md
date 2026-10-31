# @korajs/tauri

## 0.4.3-beta.14

### Patch Changes

- 2b9b8b5: Make a resolved local write a durability guarantee on every storage backend. Local CRUD, `insertMany`, mutations, and outer transactions now wait for the IndexedDB fallback's strict group-commit barrier before resolving; OPFS and native adapters pay no extra barrier. A barrier failure rejects with `WriteNotDurableError` (`WRITE_NOT_DURABLE`) after the committed operation is published, so applications can surface the problem without blindly repeating an action that already exists locally. `store:write-durability` reports failure and later recovery with the affected operation ids.

  Native SQLite now explicitly uses `synchronous = FULL` in both the better-sqlite3 adapter and Tauri plugin so a resolved write survives an operating-system crash or power loss.

- Updated dependencies [24f5531]
- Updated dependencies [6c72c04]
- Updated dependencies [6fd998a]
- Updated dependencies [946dd42]
- Updated dependencies [8667762]
- Updated dependencies [003d7bf]
- Updated dependencies [0b461fa]
- Updated dependencies [8411be3]
- Updated dependencies [714ebd2]
- Updated dependencies [180923d]
- Updated dependencies [b8f9e6f]
- Updated dependencies [9afd6a0]
- Updated dependencies [d45441e]
- Updated dependencies [4d5f2a2]
- Updated dependencies [95f5a26]
- Updated dependencies [dec63c6]
- Updated dependencies [ea9f219]
- Updated dependencies [941c67e]
- Updated dependencies [ab20522]
- Updated dependencies [2b9b8b5]
- Updated dependencies [89cb4c4]
- Updated dependencies [0b461fa]
- Updated dependencies [b378fb9]
- Updated dependencies [1c9dbe0]
- Updated dependencies [0388bd7]
- Updated dependencies [68cbb70]
- Updated dependencies [df7a430]
- Updated dependencies [b7f964a]
  - @korajs/core@1.0.0-beta.15

## 0.4.3-beta.13

### Patch Changes

- Updated dependencies [99cedc4]
- Updated dependencies [4ec1bc5]
  - @korajs/core@1.0.0-beta.14

## 0.4.3-beta.12

### Patch Changes

- Released alongside Kora 1.0.0-beta.13; no API changes.
- Updated dependencies
  - @korajs/core@1.0.0-beta.13

## 0.4.3-beta.8

### Patch Changes

- Updated dependencies [b657130]
  - @korajs/core@1.0.0-beta.9

## 0.4.3-beta.5

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @korajs/core@1.0.0-beta.5

## 0.4.3-beta.0

### Patch Changes

- Package export hygiene and auth secret-handling hardening.

  - Every published package now exposes `./package.json` in its `exports` map. Previously `require.resolve('@korajs/core/package.json')` (and the same for every other package) failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, which breaks tooling that reads a package's manifest or version at runtime.
  - `createKoraAuthServer` now warns loudly when it falls back to an ephemeral random JWT secret outside production, so a deployment that never set `NODE_ENV=production` no longer silently regenerates its signing key on every restart (which invalidates all existing tokens) without any signal.
  - `KORA_AUTH_SECRET` set to an empty or whitespace-only string is now treated as unset rather than as an invalid secret, so it triggers the intended dev fallback / production guard instead of crashing `TokenManager` with a "secret too short" error.

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @korajs/core@1.0.0-beta.0

## 0.4.2

### Patch Changes

- Updated dependencies
  - @korajs/core@0.6.0

## 0.4.1

### Patch Changes

- Updated dependencies [b909e5a]
  - @korajs/core@0.6.0

## 0.3.4

### Patch Changes

- Updated dependencies [ff155cd]
  - @korajs/core@0.4.0

## 0.3.3

### Patch Changes

- 3abd604: fix(tauri): add required `links` field and rename plugin to tauri-plugin-kora-sqlite for Tauri 2.x compatibility. Add tauri-react desktop template to CLI with --platform flag.

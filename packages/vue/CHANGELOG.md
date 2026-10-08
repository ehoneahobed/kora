# @korajs/vue

## 1.0.0-beta.14

### Patch Changes

- a0965d3: Rich-text controller never drops local edits. Saves write the full live Y.Doc instead of a base
  snapshot plus tracked deltas, so a stored change arriving during the save debounce no longer
  discards the waiting typing. A refused save keeps the edits in the document; the next edit or the
  new `retrySave()` saves them, and the first successful save clears `error`. Edits still waiting
  when the editor is destroyed are saved. New `hasUnsavedChanges` and `getUnsavedState()` (for a
  recovery copy) on the controller and on `useRichText` in React, Vue and Svelte. Saves run one at
  a time.
- Updated dependencies [afe97c6]
- Updated dependencies [99cedc4]
- Updated dependencies [8b7de83]
- Updated dependencies [4ec1bc5]
- Updated dependencies [44ddf65]
- Updated dependencies [a1e5765]
- Updated dependencies [a0965d3]
- Updated dependencies [88654fa]
  - @korajs/store@1.0.0-beta.14
  - @korajs/sync@1.0.0-beta.14
  - @korajs/core@1.0.0-beta.14

## 1.0.0-beta.13

### Minor Changes

- `useQuery` accepts refs or getters and follows its inputs; queries share the canonical
  `queryKey` and report errors.

See the [1.0.0-beta.13 release notes](https://github.com/ehoneahobed/kora/blob/main/docs/releases/v1.0.0-beta.13.md) and the [upgrade guide](https://github.com/ehoneahobed/kora/blob/main/docs/guide/upgrading-to-beta13.md) (servers first, then clients).

## 1.0.0-beta.9

### Patch Changes

- Updated dependencies [b657130]
  - @korajs/core@1.0.0-beta.9
  - @korajs/store@1.0.0-beta.9
  - @korajs/sync@1.0.0-beta.9

## 1.0.0-beta.6

### Patch Changes

- Updated dependencies
  - @korajs/store@1.0.0-beta.6

## 1.0.0-beta.5

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @korajs/sync@1.0.0-beta.5
  - @korajs/store@1.0.0-beta.5
  - @korajs/core@1.0.0-beta.5

## 1.0.0-beta.0

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
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @korajs/store@1.0.0-beta.0
  - @korajs/core@1.0.0-beta.0
  - @korajs/sync@1.0.0-beta.0

## 0.6.1

### Patch Changes

- Updated dependencies [5d2afa8]
  - @korajs/sync@0.6.1

## 0.6.0

### Minor Changes

- Public beta 0.6.0: Vue 3 and Svelte 5 bindings with shared QueryStore, sync-status controller, and richtext controller; `@korajs/core/bindings` shared types; `@korajs/auth` org hooks and providers for React/Vue/Svelte; presence/collaboration hooks; CLI scaffolds; `korajs/vue` and `korajs/svelte` meta-package re-exports; Svelte component precompile and KoraProvider context bridge fix.

### Patch Changes

- Updated dependencies
  - @korajs/core@0.6.0
  - @korajs/store@0.6.0
  - @korajs/sync@0.6.0

## 0.5.0

### Minor Changes

- b909e5a: v0.5 internal beta: structured apply results and sync apply-failure events, audit trace export, benchmark gates in CI, release-gate script, and E2E fixture hardening (SQLite worker + local multi-tab Playwright project).

### Patch Changes

- Updated dependencies [b909e5a]
  - @korajs/core@0.5.0
  - @korajs/store@0.5.0

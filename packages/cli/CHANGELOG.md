# @korajs/cli

## 1.0.0-beta.0

### Minor Changes

- New command: `kora studio` — the visual window into Kora's data plane, in two
  modes.

  FILE mode (`kora studio --db path/to/db.sqlite`) inspects any Kora database,
  strictly read-only: records with each field's LAST WRITER (which device
  changed it, and when), the full operation history behind every record, a
  causal DAG that makes concurrency visible as parallel device lanes, TIME
  TRAVEL (scrub to any operation and see the exact state at that causal cut,
  with animated replay), tombstones, the outbound sync queue, the version
  vector, and the merge audit trail. Live-updates via server-sent events when
  the database changes. No schema file needed; no extra dependencies; the UI is
  fully self-contained and offline.

  LAB mode (`kora studio --lab`) is an interactive multi-device sync
  laboratory: real Kora clients (own store, sync engine, merge pipeline)
  against a real in-process sync server. Create devices, edit records on each,
  disconnect them, make conflicting edits, watch the convergence banner flip to
  DIVERGED, reconnect, and watch every device converge — with a live event feed
  showing each operation, sync message, and merge decision as it happens.
  Chaos controls per device (drop, duplicate, reorder, latency) and atomic
  increment buttons demonstrate composition: +1 on two offline devices merges
  to +2, never lost. Everything in the Lab is throwaway; it can never touch
  real data. Optionally bring your own schema with `--schema`.

  SPECTATOR mode (`kora studio --connect wss://… --schema ./kora/schema.ts`)
  attaches to a LIVE production sync server as a real, read-only Kora client
  over the real WebSocket protocol: full history on connect (production time
  travel), live operation streaming, per-field writers, causal DAG, and merge
  audit — with no mutation surface, so it can never write to production.

  Studio answers the hardest question in a synced app — "why does this record
  look like this on this device?" — with evidence, not logs.

### Patch Changes

- e6f7c98: Every scaffolded app now includes an AGENTS.md file: framework rules, data API
  cheat sheet, and project conventions written for AI coding agents (and humans),
  so agents build Kora apps correctly instead of reaching for fetch calls and
  hand-written types.
- Clock integrity: protection against wrong device clocks at every layer.

  - HLC now validates remote timestamps BEFORE adopting them (`RemoteClockDriftError`),
    so a far-future timestamp can no longer poison a replica's clock.
  - Local timestamp generation never throws and never blocks writes: drift is
    reported through callbacks and `sync:clock-skew` events instead.
  - The sync handshake now carries `serverTime`; clients measure their own skew,
    pause sync with a new `clock-error` status when the device clock is more than
    60s fast (local writes keep queuing), and warn via events when it is very slow.
  - `SyncStatusInfo` gains `clockSkewMs`; the store's HLC receives the measured
    offset so remote validation works even on devices with wrong clocks.
  - Scaffolded templates render a plain-language banner telling end users how to
    fix their device clock. See the new Clock Integrity guide.
  - Automatic timestamp rebase: after the clock is corrected, the next handshake
    clears the clock block on its own and re-stamps queued never-acknowledged
    operations (new content-addressed ids, causal deps remapped, original order
    preserved) so sync resumes immediately instead of waiting for real time to
    catch up. A new `sync:clock-rebase` event reports `rebasedCount` and
    `maxSkewMs`. Safe because unacknowledged operations are private to the
    device — like rewriting unpushed git commits.
  - Bounded logical counter with carry: the HLC logical counter is capped at
    99,999 (`MAX_LOGICAL`, exported from `@korajs/core`) so serialized timestamps
    always sort lexicographically identically to `HybridLogicalClock.compare`.
    Overflow carries into wallTime (+1ms, counter resets) in `now()`, `receive()`,
    and `advanceTo()`; malformed timestamps (non-integer/negative fields, logical
    past the cap) are rejected with `InvalidTimestampError`
    (`INVALID_TIMESTAMP_FIELDS`) before any clock state changes, both at the
    replica and at server ingest.
  - Canonical binary encoding in op payloads: richtext `Uint8Array`/`ArrayBuffer`
    values are normalized to a tagged `{ $koraBytes: base64 }` form in
    `op.data`/`op.previousData` at operation creation, BEFORE content hashing, so
    the hash input, persisted JSON, and wire payload are the identical value and
    operation ids survive persistence round-trips. Plain-string richtext values
    are untouched (existing operation ids are unaffected); apply paths decode the
    tagged form (and tolerate the pre-fix numeric-key shape from dev databases)
    back to bytes.

- Updated dependencies
- Updated dependencies
  - @korajs/core@1.0.0-beta.0

## 0.6.0

### Minor Changes

- Public beta 0.6.0: Vue 3 and Svelte 5 bindings with shared QueryStore, sync-status controller, and richtext controller; `@korajs/core/bindings` shared types; `@korajs/auth` org hooks and providers for React/Vue/Svelte; presence/collaboration hooks; CLI scaffolds; `korajs/vue` and `korajs/svelte` meta-package re-exports; Svelte component precompile and KoraProvider context bridge fix.

### Patch Changes

- Updated dependencies
  - @korajs/core@0.6.0

## 0.5.0

### Minor Changes

- b909e5a: v0.5 internal beta: structured apply results and sync apply-failure events, audit trace export, benchmark gates in CI, release-gate script, and E2E fixture hardening (SQLite worker + local multi-tab Playwright project).

### Patch Changes

- Updated dependencies [b909e5a]
  - @korajs/core@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [ff155cd]
  - @korajs/core@0.4.0

## 0.3.4

### Patch Changes

- 3abd604: fix(tauri): add required `links` field and rename plugin to tauri-plugin-kora-sqlite for Tauri 2.x compatibility. Add tauri-react desktop template to CLI with --platform flag.

## 0.3.1

### Patch Changes

- fix(server): use BIGINT for PostgreSQL timestamp columns to prevent overflow

  - **server**: Fixed critical bug where PostgreSQL `INTEGER` columns overflowed for millisecond timestamps (wall_time, received_at, last_seen_at). Now uses `BIGINT`.
  - **server**: Added `/health` endpoint to production server.
  - **auth**: Added `UserStore` interface with `createSqliteUserStore` and `createPostgresUserStore` factory functions.
  - **core**: Added `sync:auth-failed` event for detecting stale auth tokens.
  - **sync**: Sync engine now emits `sync:auth-failed` when the server rejects authentication.
  - **cli**: Added AWS ECS Fargate and Lightsail Container deploy adapters.
  - **cli**: Docker builds now use `--platform linux/amd64` for Apple Silicon compatibility.
  - **cli**: Lightsail adapter forwards `DATABASE_URL`, `AUTH_SECRET`, `PUBLIC_URL` environment variables to containers.
  - **cli**: Fixed trailing slash in Lightsail URLs causing double-slash in sync endpoint.

- Updated dependencies
  - @korajs/core@0.3.1

## 0.3.0

### Patch Changes

- 6a05e88: Performance: Replace O(n²) topological sort with binary heap in @korajs/core (19x faster sync for large operation sets).

  New: @korajs/auth package with sessions, TOTP MFA, organizations, RBAC, passkeys, encrypted tokens, and E2E operation encryption (912 tests).

  New: Full Preact-based DevTools UI panel with sync timeline, conflict inspector, operation log, and network status.

  Docs: Comprehensive documentation refinement — added API references for merge, sync, auth, and devtools; added authentication guide; expanded sync configuration guide; updated all package descriptions.

- Updated dependencies [6a05e88]
  - @korajs/core@0.3.0

## 0.2.0

### Minor Changes

- 6fb50fd: Add `kora deploy` command for one-command deployment to Fly.io and Railway.

  Features:

  - Full Fly.io and Railway adapters with provision, build, deploy, rollback, logs, and status
  - Dockerfile generation with native dependency handling (better-sqlite3)
  - Server bundling via esbuild with CJS compatibility shims
  - Client build with SQLite WASM asset patching (OPFS proxy + unhashed wasm)
  - Deploy state persistence for subsequent deploys
  - Platform config generation (fly.toml, railway.json)
  - Subcommands: `kora deploy status`, `kora deploy logs`, `kora deploy rollback`
  - Non-interactive `--confirm` mode for CI/CD

## 0.1.11

### Patch Changes

- Add Tailwind CSS templates, polished dark-themed UI, --yes/--tailwind/--sync flags, devtools enabled by default, and persistent SQLite server stores in sync templates.

## 0.1.3

### Patch Changes

- Fix Windows compatibility for kora dev command (resolve .cmd shims, spawn with shell)

## 0.1.2

### Patch Changes

- Fix template path resolution in create-kora-app and add package READMEs
- Updated dependencies
  - @korajs/core@0.1.2

## 0.1.1

### Patch Changes

- Add create-kora-app package for npx support

## 0.1.0

### Minor Changes

- Initial release

### Patch Changes

- Updated dependencies
  - @korajs/core@0.1.0

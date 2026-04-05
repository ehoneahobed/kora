
  Now → Next (Critical Path)

  - Epic A: Complete Phase 4 promise (create -> pnpm dev one command)
  - Epic B: Fix browser durability gap (Phase 1 completion)
  - Epic C: Resolve createApp contract mismatch (Phase 2 completion)

  ———

  Epic A — Phase 4 Completion (Highest Priority)

  - A1: Template dev scripts use kora dev
      - Update packages/cli/templates/react-basic/package.json.hbs:7
      - Update packages/cli/templates/react-sync/package.json.hbs:7
      - Acceptance: scaffolds run with only pnpm dev, no second terminal.
      - Estimate: S (0.5d)
  - A2: Add kora.config.ts loading + schema/dev config
      - Add config loader in CLI (packages/cli/src/commands/dev/* + utility).
      - Support: schema path override, dev port, sync enable/disable, sync port.
      - Acceptance: command respects config defaults and CLI flags override config.
      - Estimate: M (1–2d)
  - A3: Sync detection from config (not only server.ts)
      - Current detection is file-presence based; extend to config-first with
        fallback.
      - Acceptance: sync starts when config requests it even if layout differs.
      - Estimate: S (0.5–1d)
  - A4: DevTools injection path (or roadmap re-scope)
      - Either implement injection hook or explicitly defer in roadmap.
      - Acceptance: clear behavior documented and tested.
      - Estimate: M (1d)
  - A5: E2E smoke for “under 10 min” path
      - Add integration test in CLI package for scaffold + pnpm dev command wiring
        (mock subprocesses if needed).
      - Acceptance: CI-level guard for one-command startup path.
      - Estimate: M (1d)

  ———

  Epic B — Browser Durability (Phase 1 Gap)

  - B1: Worker export/import support
      - Implement serialization path in packages/store/src/adapters/sqlite-wasm-
        worker.ts:173.
      - Acceptance: export no longer returns EXPORT_NOT_SUPPORTED.
      - Estimate: M/L (2–3d)
  - B2: IndexedDB adapter restore-on-open
      - Implement load-from-IDB and hydrate DB in packages/store/src/adapters/
        indexeddb-adapter.ts:62.
      - Acceptance: data survives close/reopen across sessions.
      - Estimate: M (1–2d)
  - B3: Durability test matrix
      - Add reopen persistence tests for IndexedDB fallback and OPFS path.
      - Acceptance: regression tests for write→close→open→read.
      - Estimate: M (1d)

  ———

  Epic C — createApp Behavior Contract

  - C1: Decision record: pre-ready behavior
      - Current behavior throws before ready (kora/src/create-app.ts:199) vs
        roadmap “empty results.”
      - Decide one canonical contract.
      - Estimate: XS (0.25d)
  - C2a (if keeping throw): update roadmap/docs/tests.
  - C2b (if changing to empty results): implement buffering/no-op query behavior
    and tests.
      - Estimate: S for docs-only, L for behavior change.

  ———

  Post-Critical (After A/B/C)

  - D: Phase 3 breadth — add Postgres/MySQL server stores and export surface.
  - E: Phase 5 — Yjs richtext merge strategy + serializer + React hook.
  - F: Phase 6 — actual scope filtering in sync/server (types already present).
  - G: Phase 7 — migrate command implementation (currently stub).
  - H: Phase 8/9/10 — DevTools UI extension, protobuf/http transport, perf gates,
    publish pipeline.

  ———

  Suggested 2-Week Sprint Cut

  - Week 1: A1, A2, A3, A5
  - Week 2: B1, B2, B3, C1 (+ C2 decision path)

  If you want, I’ll start executing this now from A1+A2 and send patches
  incrementally.

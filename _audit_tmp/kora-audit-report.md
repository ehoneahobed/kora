# Kora.js State-of-the-Codebase Audit

**Date:** July 13, 2026
**Scope:** Full working tree from your Mac (uncommitted changes included), published npm packages at 0.6.0, cold-start path as a new user experiences it.
**Method:** Everything below was executed and verified in a clean Linux environment, not inferred from reading code or docs.

---

## Executive summary

The framework core is real. Schema, storage (SQLite WASM + OPFS), operations, HLC, merge, and sync are implemented, tested (3,300+ unit tests, verified passing), and work end to end. This is not an aspirational codebase.

However, the single most important user journey was broken at the moment of this audit: **every app scaffolded by the published `create-kora-app` had a dead Add button and a sync badge stuck on "Offline."** A new user following your README's 10-minute quickstart hit a silently non-functional app. The root cause is a React StrictMode lifecycle bug in `@korajs/react`, present in both the published 0.6.0 packages and your repo HEAD. Your own e2e suite catches it — 6 of 9 tests fail, and your local `test-results/.last-run.json` confirms they were failing on your machine too.

The bug is now diagnosed, fixed, and verified (patch attached). With the fix, all 7 runnable e2e tests pass and the scaffolded template works under StrictMode: add, toggle, offline mutation, reload persistence, live sync status.

---

## Verified working (ran it, saw it work)

| Area | Evidence |
|---|---|
| Monorepo build | All 16 turbo build tasks succeed from a clean checkout |
| Unit tests | 3,311 passed, 4 skipped across all packages |
| Core data plane (Node) | `createApp` → `insert` → `findById` roundtrip works (after ESM fix below) |
| Core data plane (browser) | Insert, reactive query update, OPFS persistence across reload — all verified in headless Chromium |
| SQLite WASM + OPFS | `.kora-opfs` created, data survives reload, worker + opfs-async-proxy both running |
| Cold-start scaffold | `npx create-kora-app my-app --yes` scaffolds, installs, and boots vite + sync server cleanly |
| Sync | With fix applied: two-context sync, offline convergence, multi-tab sync all pass in e2e |
| npm publication | korajs, create-kora-app, and all @korajs/* packages live at 0.6.0 |

## Defects found

### 1. LAUNCH-BLOCKING (fixed in attached patch): React hooks break under StrictMode

`useMutation`, `useSyncStatus`, and `useRichText` create their controller in `useMemo` and destroy it in the effect cleanup:

```ts
const controller = useMemo(() => createMutationController(...), [])
useEffect(() => () => controller.destroy(), [controller])
```

React 18/19 StrictMode (dev) mounts, unmounts, and remounts every component. The simulated unmount runs the cleanup and permanently destroys the memoized controller; the remount re-runs the effect but gets the same destroyed instance back from `useMemo`. From then on every `mutate()` throws `Mutation controller is destroyed` — and `mutate()` intentionally swallows errors into state that the templates never render. Result: silent total failure.

All five shipped templates (`react-tailwind-sync`, `react-tailwind`, `react-sync`, `react-basic`, `tauri-react`) and the e2e fixture app wrap the tree in `<StrictMode>`, so this hits 100% of scaffolded apps in dev mode. It also explains the sync badge frozen at "Offline": the sync-status controller is destroyed the same way, so its snapshot never updates.

Notable: your CLAUDE.md explicitly lists "Works with React.StrictMode (double-mount safe)" as an acceptance criterion for React hooks. The AI that built this wrote the requirement and then violated it — a perfect case study in why this audit had to run before launch.

**Fix (attached, verified):** new `useController` lifecycle helper in `@korajs/react` that keeps the controller in a ref, destroys it on unmount, and lazily recreates it on remount. All three hooks migrated. Verification: react unit tests 55/55, e2e 7/7 passing (was 1/7), template exercised under StrictMode in headless Chromium including offline add and reload persistence. Vue and Svelte bindings are unaffected (their unmount hooks only fire on real unmounts).

### 2. HIGH: `korajs` unusable from plain Node.js ESM (fixed in attached patch)

`packages/sync/src/protocol/serializer.ts` imports `protobufjs/minimal`. protobufjs has no `exports` map, so Node ESM requires the explicit `protobufjs/minimal.js`. Bundlers (Vite, tsup) tolerate the extensionless form, which is why browsers work but `import { createApp } from 'korajs'` in plain Node dies with `ERR_MODULE_NOT_FOUND` at module load. This breaks server-side usage, scripting, and any tutorial where you demo the API in a Node REPL — something you will absolutely want to do on camera. One-line fix included and verified.

### 3. MEDIUM: e2e suite failing at HEAD, and the release gate that skips it

The 6 failing e2e tests were failing on your machine (per `.last-run.json`) before this session. `package.json` contains both `test:pre-release` (includes e2e) and `test:pre-release:core` (excludes e2e). If v0.6 was published via the `:core` variant, the gate designed to catch exactly this class of bug was bypassed. Recommendation: e2e green becomes non-negotiable for any publish, and CI should run e2e on every PR touching react/store/sync.

### 4. LOW: flaky sync-encryptor tests under parallel load

5 tests in `sync-encryptor.test.ts` timed out (5s) under `turbo test --concurrency=6` but pass when the package runs alone. Likely WebCrypto starvation under load, not a product bug. Worth bumping the timeout or isolating, because a flaky release gate trains you to ignore red.

### 5. LOW: pre-existing typecheck failures in working tree

`pnpm typecheck` fails at `packages/sync/src/reactivity/sync-status-controller.test.ts` (2 errors, unrelated to the patch — verified present before and after). Appears connected to your uncommitted KoraEventEmitter changes. Needs reconciling before the next release.

### 6. Hygiene observations

`packages/tauri/plugin/target` holds 1.1 GB of Rust build artifacts inside the repo directory; your Mac showed ~118 MB free disk during this audit, which will start corrupting your dev experience soon. The repo root also carries internal planning docs (STRATEGY.md, product_idea.md, AUTH-IMPLEMENTATION-PLAN.md, TO-BUILD.md, ROADMAP.md, kora-db binary) that you likely don't want public on day one. README claims "2,100+ tests"; the real number is now 3,300+ — undersell corrected in your favor.

---

## What this means for the one-month launch

Scope recommendation, in order of confidence earned by this audit:

**Tier 1 — launch surface (verified solid once patched):** core, store, merge, sync, server, react, cli, create-kora-app, korajs meta-package. This is the complete Next.js-like story: scaffold → local-first CRUD → sync → deploy server.

**Tier 2 — ship but label experimental:** devtools (71 tests pass; extension UX unverified in this audit), auth (912 tests pass, largest package, but it's also your newest code and touches security — needs its own adversarial pass before you present it as a headline feature).

**Tier 3 — hold back from v1 messaging:** vue, svelte, tauri. They build and their small test suites pass, but 452 to 599 LOC each with 5 or 6 test files is thin coverage for a public commitment, and every framework you announce doubles your support surface on launch week.

**Process changes before announcing:** publish a patched 0.6.1 (the currently published 0.6.0 is broken for every new user, today, on npm); make `test:pre-release` (with e2e) the only publish path; add a StrictMode regression test at the unit level so this never rides again on e2e alone.

---

## Files delivered with this report

- `kora-strictmode-fix.patch` — applies cleanly at repo root with `git apply kora-strictmode-fix.patch`. Contains: new `packages/react/src/hooks/use-controller.ts`, migrations of the three affected hooks, and the protobufjs ESM fix.

## Verification log (reproduce any of this)

1. `pnpm install && pnpm build` — 16/16 tasks.
2. `pnpm test` — 3,311 passed / 4 skipped (sync-encryptor flakes under turbo concurrency; pass in isolation).
3. `npx create-kora-app my-app --yes` with published 0.6.0 → dev server boots → headless Chromium → typing a todo and pressing Add: **no insert, no error, badge "Offline"**.
4. Instrumented `mutateAsync` → `Error: Mutation controller is destroyed`.
5. Removed `<StrictMode>` → everything works → root cause confirmed.
6. Applied patch, rebuilt `@korajs/react` → StrictMode template: add works, offline add works, reload persists both, badge shows live status.
7. e2e suite: 1 passed / 6 failed before patch → 7 passed / 2 skipped after (skipped pair is the local-multi-tab project, skipped in this environment before and after — SharedWorker constraint, worth verifying on your Mac).

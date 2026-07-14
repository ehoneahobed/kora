# Contributing to Kora.js

Thanks for your interest in improving Kora. This document explains how to get a working development setup, what we expect from contributions, and how changes get released.

## Development setup

Prerequisites: Node.js 20+ and pnpm 9+.

```bash
git clone https://github.com/ehoneahobed/kora.git
cd kora
pnpm install
pnpm build
pnpm test
```

The repo is a pnpm + Turborepo monorepo. Packages live in `packages/`, the meta-package in `kora/`, end-to-end tests in `e2e/`, and the docs site in `docs/`. Build order follows the dependency graph in `CLAUDE.md`; `pnpm build` handles it for you.

Useful commands while working:

```bash
pnpm test                       # all unit and integration tests
pnpm --filter @korajs/store test   # one package's tests
pnpm typecheck                  # strict TypeScript across the workspace
pnpm lint                       # Biome lint + format check
pnpm lint:fix                   # auto-fix formatting
pnpm test:e2e                   # Playwright suite (run `cd e2e && npx playwright install chromium` once first)
```

## What makes a good contribution

Bug reports with a minimal reproduction are the most valuable thing you can send. A repro created with `npx create-kora-app` plus the smallest schema and steps that show the problem will usually get fixed quickly.

For code contributions, a few ground rules keep the codebase coherent:

- Open an issue before large changes. A short design conversation saves you from building something we cannot merge.
- Every behavior change needs a test. Bug fixes need a test that fails without the fix.
- Correctness beats performance, and the merge engine's laws are non-negotiable: merges must stay deterministic, commutative, and idempotent. If your change touches `@korajs/merge`, `@korajs/sync`, or the clock code in `@korajs/core`, run the property and chaos suites (`pnpm test:release-gate`).
- TypeScript strict mode, no `any`, no non-null assertions, no enums. Biome enforces formatting; run `pnpm lint:fix` before pushing.
- React hooks must survive StrictMode's double mount. The e2e fixture app runs with StrictMode enabled specifically to catch lifecycle bugs; do not remove it.
- Public API changes require a changeset: run `pnpm changeset` and describe the change from a user's point of view.

## Pull request checklist

Before opening a PR, make sure `pnpm build && pnpm test && pnpm typecheck && pnpm lint` all pass locally, and `pnpm test:e2e` if your change touches store, sync, react bindings, the CLI, or templates. Keep PRs focused on one change. Reference the issue they address.

## Releases

Releases are cut by the maintainer using changesets. Version bumps, changelogs, and npm publishing all flow from the changeset files merged with PRs, so an accurate changeset is part of a complete contribution.

## Questions

Open a GitHub Discussion for questions and ideas, and an Issue for bugs. Security problems should never be reported publicly; see [SECURITY.md](SECURITY.md).

---
title: npm Publish Checklist
description: "The npm publish checklist used for Kora.js releases: build, test, version, and publish steps with verification."
---

# npm publish checklist — v0.6.0 public beta

Use this when promoting **local 0.6.0** to npm (registry currently at **0.5.0** for linked packages).

## Current registry state (verify before publish)

```bash
npm view korajs version          # 0.5.0 → publishing 0.6.0
npm view @korajs/vue version     # 0.5.0 → publishing 0.6.0
npm view @korajs/svelte version  # 0.5.0 → publishing 0.6.0
npm view create-kora-app version # 0.1.23 → publishing 0.1.24
npm view @korajs/tauri version   # 0.4.1 → publishing 0.4.2
```

The `@korajs` npm org already exists. Vue and Svelte bindings were first published at **0.5.0**; this release is a **minor bump**, not a greenfield scope setup.

---

## Pre-publish gates

Run from repo root:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm test:release-gate
pnpm typecheck
```

Optional full gate (includes lint + E2E):

```bash
pnpm test:pre-release
```

**CI note:** `ci.yml` runs `pnpm lint`. Resolve any Biome failures on `main` before merging release-related PRs.

Manual smoke (see [v0.6-public-beta.md](./v0.6-public-beta.md)):

- Chrome / Firefox / Safari: offline CRUD, multi-tab, sync, DevTools
- `npx create-kora-app my-app --template react-tailwind-sync` after publish

---

## Dry-run (no registry writes)

Requires `npm login` or `NPM_TOKEN` in `~/.npmrc`.

```bash
pnpm build
pnpm changeset publish --dry-run
```

Expected: **16 packages** with local versions not yet on npm:

| Package | Local | npm (today) |
|---------|-------|-------------|
| `korajs` | 0.6.0 | 0.5.0 |
| `@korajs/core` … `@korajs/test` (linked) | 0.6.0 | 0.5.0 |
| `@korajs/vue`, `@korajs/svelte` | 0.6.0 | 0.5.0 |
| `create-kora-app` | 0.1.24 | 0.1.23 |
| `@korajs/tauri` | 0.4.2 | 0.4.1 |

`changeset publish` replaces `workspace:*` dependencies with concrete semver in published tarballs.

---

## Version bump model

Linked packages (single version line) are defined in [`.changeset/config.json`](../../.changeset/config.json):

`@korajs/core`, `@korajs/store`, `@korajs/merge`, `@korajs/sync`, `@korajs/server`, `@korajs/react`, `@korajs/auth`, `@korajs/devtools`, `@korajs/cli`, `@korajs/test`, `@korajs/vue`, `@korajs/svelte`, `korajs`

**Not linked** (independent semver):

- `create-kora-app` — bump when CLI/templates change
- `@korajs/tauri` — desktop adapter; on its own cadence

**Important:** Package versions are **already set to 0.6.0** in `package.json`. Do **not** run `pnpm changeset version` again unless you add a new changeset (that would bump to 0.7.0). Publish directly:

```bash
pnpm build
pnpm changeset publish
```

For **future** releases after 0.6.0, use the standard Changesets flow:

```bash
pnpm changeset          # describe change, select packages
pnpm changeset version  # bumps versions + CHANGELOG
pnpm build
pnpm changeset publish
```

Or merge the **Version Packages** PR created by [`.github/workflows/release.yml`](../../.github/workflows/release.yml).

---

## Publish (maintainers)

### Option A — Local publish

```bash
npm login   # or export NPM_TOKEN
pnpm build
pnpm changeset publish
```

Verify:

```bash
npm view korajs version
npm view @korajs/vue version
npx create-kora-app@latest my-smoke-test --yes --sync
```

### Option B — GitHub Actions (recommended after 0.6.0)

1. Ensure `NPM_TOKEN` secret is set on the repo (Automation token, publish access to `@korajs/*`).
2. Push to `main` with versions already bumped (current state).
3. Trigger publish manually or via a one-off workflow dispatch, **or** use local Option A once, then revert to changeset PR flow for 0.6.1+.

The default `release.yml` uses `changesets/action`, which expects pending `.changeset/*.md` files for version PRs. Because 0.6.0 is pre-bumped, the **first** 0.6.0 publish is easiest via Option A.

---

## Post-publish

- [ ] Tag git: `git tag v0.6.0 && git push origin v0.6.0`
- [ ] GitHub Release notes from [v0.6-public-beta.md](./v0.6-public-beta.md) highlights
- [ ] Update [docs/releases/README.md](./README.md) — mark v0.6 shipped
- [ ] Smoke `npx create-kora-app` on a clean machine (no monorepo)
- [ ] Announce: Vue/Svelte bindings, modular `createApp`, auth sync coordinator, per-app query cache

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `E403` / `402` on `@korajs/*` | Confirm npm user is member of `@korajs` org with publish rights |
| `E404` on `create-kora-app` | Usually missing auth token; run `npm whoami` |
| Publish skips packages | Local version must be **greater** than registry (`npm view pkg version`) |
| `workspace:*` in published package | Run `changeset publish`, not raw `npm publish` per package |
| Canary tags on every main push | [canary.yml](../../.github/workflows/canary.yml) runs when **no** `.changeset/*.md` exists; add a changeset or disable canary until 0.6.0 ships |

---

## Document history

| Date | Note |
|------|------|
| 2026-06-20 | Checklist for v0.6.0 public beta (pre-bumped versions, dry-run verified) |
| 2026-06-20 | **Published** — all 16 packages on npm at 0.6.0 / 0.1.24 / 0.4.2 |

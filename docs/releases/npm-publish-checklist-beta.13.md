---
title: npm Publish Checklist (1.0.0-beta.13)
description: "Maintainer runbook for the 1.0.0-beta.13 security release: publish to npm, then make the code public, then publish the advisory, in one sitting."
---

# npm publish runbook — 1.0.0-beta.13 (security release)

Use with the [release notes](./v1.0.0-beta.13.md) and the
[security advisory](./security-advisory-beta13.md).

**Why the order matters.** The private repository (`ehoneahobed/kora-private`, remote `private`)
contains exploit-level reproduction tests and the remediation evidence. The fixed packages must be
on npm **before** that code becomes public, and the advisory goes out right after. Do steps (b) to
(f) in one sitting, on one machine.

The manifests are already versioned and the changesets are consumed (listed in
`.changeset/pre.json`): do **not** run `pnpm beta:bump`, `pnpm beta:release` or
`pnpm changeset version` for this release.

| Package set (15) | Version |
|---|---|
| `korajs`, `@korajs/auth`, `@korajs/cli`, `@korajs/core`, `@korajs/devtools`, `@korajs/merge`, `@korajs/react`, `@korajs/server`, `@korajs/store`, `@korajs/svelte`, `@korajs/sync`, `@korajs/test`, `@korajs/vue` | `1.0.0-beta.13` |
| `create-kora-app` | `0.1.25-beta.12` |
| `@korajs/tauri` | `0.4.3-beta.12` |

The stable `latest` dist-tags (`korajs@0.6.1`, `create-kora-app@0.1.24`, `@korajs/tauri@0.4.2`, ...)
must not move.

Throughout, `SHA` is the full commit id of the merge on private `main` from step (a).

## (a) Merge into private `main`

1. **Stop the private repository's CI from publishing on its own.** Its `release` workflow runs on
   every push to `main`; with no pending changesets it runs `pnpm release` (`changeset publish`),
   which would publish beta.13 from CI before your gates run if `kora-private` has an `NPM_TOKEN`
   secret (and fail noisily if not). Disable `release` and `canary` in `kora-private` first
   (Actions, select the workflow, "Disable workflow"; or
   `gh workflow disable release -R ehoneahobed/kora-private` and the same for `canary`). Delete
   the stale `changeset-release/main` branch there (a "Version Packages" commit from an earlier
   run; never merge it).
2. Merge the release pull request (`wip/phase4/release-prep`, which contains `fix/phase4-rc`, into
   `main`; it supersedes PR #4) after CI is green. Note the merge commit:

   ```bash
   git fetch private
   SHA=$(git rev-parse private/main)
   echo "$SHA"
   git merge-base --is-ancestor origin/main "$SHA" && echo "fast-forward OK"   # origin/main = v1.0.0-beta.12 (91c6350)
   ```

## (b) Gates on the maintainer machine

Node 20+, pnpm 9.15.4, a clean checkout of exactly `SHA`:

```bash
git clone https://github.com/ehoneahobed/kora-private.git kora-release && cd kora-release
git checkout --detach "$SHA"
git status --porcelain            # must print nothing
pnpm install --frozen-lockfile

# Optional but recommended: run the Postgres suites too (they are skipped without it).
export KORA_PG_TEST_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres

pnpm test:pre-release
pnpm release:dry-run
```

- `pnpm test:pre-release` runs lint, build, every package's tests, typecheck, the release gate
  (production path, reconnect, real-path chaos, benchmark gates), then
  `pnpm --filter kora-e2e test:e2e:install` (`playwright install chromium`, downloads a browser;
  on a bare Linux host run `npx playwright install-deps chromium` once first) and the Playwright
  end-to-end suite.
- Postgres: any reachable Postgres 14+ works (for example
  `docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16`). Without
  `KORA_PG_TEST_URL` the Postgres tests are skipped, not failed.
- Optional full remediation gate: `pnpm remediation:all` (every reproduction test against the
  tracker; uses Postgres and Chromium when available).
- `pnpm release:dry-run` packs every publishable package locally (no registry writes) and must
  print 15 `✓` lines with the versions in the table above, no `workspace:` ranges and every
  declared entry point present.

Stop here if anything fails.

## (c) Publish to npm

```bash
npm whoami                                  # the account must be able to publish @korajs/* and create-kora-app
pnpm -r publish --tag beta --no-git-checks
```

- `-r` publishes every non-private workspace package in dependency order, rewriting
  `workspace:*` to the exact versions. `--no-git-checks` is needed because you are on a detached
  `SHA`, not a branch. `--tag beta` keeps `latest` untouched.
- **2FA.** npm asks for a one-time password or a browser confirmation per publish. Pass
  `--otp=<code>` for a code from your authenticator; a code is valid for about 30 seconds, so it
  can expire part-way through 15 packages.
- **Partial publish.** If the command stops part-way (expired OTP, network, `E403`), do not
  bump anything: run the same `pnpm -r publish --tag beta --no-git-checks` again. pnpm skips
  versions that are already on the registry and publishes the rest. Then verify with (d).
- Do not use `pnpm release` here: it is the same publish through Changesets, but the command above
  is the one beta.12 was published with.

## (d) Verify the registry, then smoke-test

```bash
for p in korajs @korajs/auth @korajs/cli @korajs/core @korajs/devtools @korajs/merge \
         @korajs/react @korajs/server @korajs/store @korajs/svelte @korajs/sync @korajs/test @korajs/vue; do
  printf '%-18s ' "$p"; npm view "$p@1.0.0-beta.13" version
done
npm view create-kora-app@0.1.25-beta.12 version
npm view @korajs/tauri@0.4.3-beta.12 version

npm view korajs dist-tags                 # beta: 1.0.0-beta.13, latest: 0.6.1 (unchanged)
npm view @korajs/server dist-tags         # beta: 1.0.0-beta.13
npm view create-kora-app dist-tags        # beta: 0.1.25-beta.12, latest: 0.1.24
npm view @korajs/tauri dist-tags          # beta: 0.4.3-beta.12, latest: 0.4.2
npm view korajs@1.0.0-beta.13 dependencies   # exact 1.0.0-beta.13 pins, no workspace: ranges
```

Every `npm view <pkg>@<version> version` must print the version (an `E404` means it is missing:
re-run (c)). Registry reads can lag a minute behind a publish.

Smoke test from outside the monorepo, in an empty directory:

```bash
cd "$(mktemp -d)"
npm create kora-app@beta smoke -- --template react-basic --pm npm --yes
#   equivalent: npx create-kora-app@0.1.25-beta.12 smoke --template react-basic --pm npm --yes
cd smoke && grep '"korajs"' package.json      # "1.0.0-beta.13"
npm run build

cd "$(mktemp -d)" && npm init -y >/dev/null
npm install korajs@1.0.0-beta.13 @korajs/server@1.0.0-beta.13
node -e "import('korajs').then(m => console.log(typeof m.createApp))"   # function
```

## (e) Go public

Only after (d) is green:

```bash
cd kora-release     # the clone from (b), at SHA
git remote add origin https://github.com/ehoneahobed/kora.git 2>/dev/null || true
git fetch origin
git merge-base --is-ancestor origin/main "$SHA" && echo "fast-forward OK"
git push origin "$SHA":refs/heads/main            # fast-forward; never --force
git tag -a v1.0.0-beta.13 "$SHA" -m "Kora.js 1.0.0-beta.13"
git push origin v1.0.0-beta.13
```

Push only `main` and the tag. Never push `wip/*`, `fix/*` or `changeset-release/*` branches to the
public remote.

What the public repository's workflows do on that push to `main`:

- **release**: changesets/action finds no pending changesets (every `.changeset/*.md` is listed in
  `pre.json`), so it runs `pnpm release` = `pnpm build && changeset publish`. Changesets checks
  each package against npm, finds `1.0.0-beta.13` / `0.1.25-beta.12` / `0.4.3-beta.12` already
  published and publishes nothing (no double publish, no Version Packages PR). If some package was
  *not* published in (c), this job publishes it with the public repo's `NPM_TOKEN`: that is why (d)
  comes first.
- **canary**: skipped. It publishes only when `.changeset/` holds no `*.md` files, and the consumed
  changesets stay on disk in pre mode.
- **ci**, **e2e**, **remediation**: run the test suites on the public commit.
- **docs**: deploys the documentation site to GitHub Pages (the push touches `docs/**`), including
  the upgrade guide. `docs/releases/` is excluded from the site build, so the release notes and
  advisory are readable only on GitHub.

The tag push triggers nothing (all workflows are branch-filtered).

## (f) Advisory and release

1. **GitHub Security Advisory** on `ehoneahobed/kora`: Security, Advisories, "New draft security
   advisory". Paste [security-advisory-beta13.md](./security-advisory-beta13.md) (title, summary,
   details, workarounds, credits). Ecosystem npm; affected packages `@korajs/server`,
   `@korajs/auth`, `@korajs/sync`, `@korajs/store`, `korajs`; affected versions `<= 1.0.0-beta.12`;
   patched `1.0.0-beta.13`; severity Critical (CVSS vector in the file); CWEs as listed. Click
   "Request CVE", then "Publish advisory". Add the GHSA id (and the CVE when assigned) to
   `docs/releases/security-advisory-beta13.md` in a follow-up commit.
2. **GitHub release**: Releases, "Draft a new release", tag `v1.0.0-beta.13`, title
   "Kora.js 1.0.0-beta.13 (security release)", body from [v1.0.0-beta.13.md](./v1.0.0-beta.13.md),
   tick "Set as a pre-release", link the advisory.
3. **Docs**: confirm the `docs` workflow deployed and the site shows "Upgrading to beta.13"; if it
   did not run, trigger it with "Run workflow" (`workflow_dispatch`). The README already points at
   the release notes, the advisory and the upgrade guide.

## (g) After the release

- Announce (README notice is in place; post the advisory link and the "servers first, then
  clients" upgrade order wherever users follow the project).
- Watch new issues, npm download/installation reports and the advisory for 72 hours, in particular
  upgrade reports (`NODE_ID_CLAIMED`, `SCOPE_REQUIRED`, Postgres first-start migration time).
- Private repository: delete its `wip/*` branches and the merged `fix/*` branches, then archive
  it (or keep it for the next embargoed fix and re-enable its workflows only if needed). The
  public repository now holds the full history.
- Next release planning: protocol 1 refused, `experimental.legacyMerge` removed,
  `allowLegacyAnonymousClaims` defaults to `false`.

## Rollback and recovery

| Problem | Action |
|---|---|
| A published package is broken | Never unpublish (npm allows it only within 72 hours and the version can never be reused). Fix forward with the next beta version (`pnpm beta:bump`, the normal gates, publish) and deprecate the bad one: `npm deprecate korajs@1.0.0-beta.13 "Broken, upgrade to the next beta"` (repeat per package). |
| `beta` dist-tag points at the wrong version | `npm dist-tag add korajs@<good-version> beta` (per package). Check with `npm view <pkg> dist-tags`. |
| `latest` moved by mistake | `npm dist-tag add korajs@0.6.1 latest` (and the previous `latest` of each affected package: `create-kora-app@0.1.24`, `@korajs/tauri@0.4.2`, the scoped packages' previous `latest`). |
| Publish stopped part-way | Re-run `pnpm -r publish --tag beta --no-git-checks` from the same `SHA`; already-published versions are skipped. Do not go public until (d) passes. |
| Public push rejected (not a fast-forward) | Stop. Someone pushed to public `main` after beta.12. Do not force-push: merge `origin/main` into private `main`, re-run (b) on the new commit, publish nothing new (versions already on npm), then push. |
| Packages published but the code must stay private longer | Keep the advisory in draft; the published tarballs contain no tests or remediation material, but the fix is visible in the compiled code, so go public as soon as possible. |

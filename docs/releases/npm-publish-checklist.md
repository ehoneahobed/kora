---
title: npm Publish Checklist
description: "The maintainer checklist for validating, publishing, and verifying a Kora.js release on npm through the Changesets Version Packages pull request."
---

# npm publish checklist

The current release is **1.0.0-beta.15** (draft): [release notes](./v1.0.0-beta.15.md),
[security advisory](./security-advisory-beta15.md), [upgrade guide](../guide/upgrading-to-beta15.md).
Releases since beta.12 go through the Changesets flow below; do **not** run `pnpm beta:bump` or
`pnpm beta:release`, which belong to the older manual flow.

## How a release is made

The repository is in Changesets prerelease mode (`.changeset/pre.json`, tag `beta`). Every push to
`main` runs [the release workflow](../../.github/workflows/release.yml), which builds the workspace and
runs `changesets/action`:

- while changesets are pending, it opens or updates the **"Version Packages (beta)"** pull request
  (for beta.15: #19), which bumps every manifest, writes the `CHANGELOG.md` files and consumes the
  changesets;
- when that pull request is merged, the next run finds nothing pending and runs `pnpm release`
  (`pnpm build && changeset publish`), publishing under the `beta` dist-tag with the repository's
  `NPM_TOKEN`.

## Before merging the Version Packages pull request

Run from the repository root on the exact commit of the pull request's head:

```bash
pnpm install --frozen-lockfile
pnpm test:pre-release
pnpm test:e2e:offline
pnpm release:matrix
pnpm release:dry-run
```

`release:dry-run` builds and locally packs every publishable workspace package. It verifies the
packed manifests, resolves `workspace:` dependencies, and checks declared entry points without
contacting or writing to the npm registry.

Then check:

1. **The publish set.** 16 public packages: the 14 linked packages (`korajs`, `@korajs/auth`, `cli`,
   `core`, `devtools`, `merge`, `react`, `server`, `spaces`, `store`, `svelte`, `sync`, `test`,
   `vue`) at `1.0.0-beta.15`, plus `create-kora-app` and `@korajs/tauri` at the versions the pull
   request sets. `@korajs/spaces` is published for the first time. The pull request also versions the
   private workspace packages (`kora-e2e-fixture`, `kora-e2e-tauri-app`, `kora-full-stack`,
   `@korajs/parity-bench-apps`); they are `private: true` and are not published.
2. **The release notes and advisory** are re-checked against the pull request's head (see their
   "Open items" and "Before publishing"), and the package versions in the notes are filled in from
   the pull request.
3. **The latest parity nightly on `main`** passed every cell and K3.
4. The repository `NPM_TOKEN` can publish `@korajs/*`, `korajs` and `create-kora-app`, including a
   new package under `@korajs`.

## Publish

Merge the Version Packages pull request and monitor the `release` workflow. Do not run a local
publish at the same time.

If the workflow cannot publish (for example a token problem), publish locally from the merged
commit instead:

```bash
npm whoami
pnpm release:dry-run
pnpm release
```

Complete any npm two-factor authentication prompt; do not retry blindly if the command reports a
partial publish (see Troubleshooting).

## Verify

```bash
npm view korajs dist-tags
npm view @korajs/spaces dist-tags
for p in korajs @korajs/auth @korajs/cli @korajs/core @korajs/devtools @korajs/merge @korajs/react \
  @korajs/server @korajs/spaces @korajs/store @korajs/svelte @korajs/sync @korajs/test @korajs/vue; do
  npm view "$p@1.0.0-beta.15" version
done
npm view create-kora-app dist-tags
npm view @korajs/tauri dist-tags
```

`changeset publish` sets only the `beta` dist-tag. Before beta.15, `latest` of `korajs`, the other
`@korajs/*` packages, `create-kora-app` and `@korajs/tauri` pointed at the versions published with beta.14, and
`latest` of `@korajs/spaces` at a canary. Decide whether to move `latest`
(`npm dist-tag add <package>@<version> latest`); the `@korajs/spaces` `latest` dist-tag is listed in
the release notes as a 1.0 release-candidate item.

Then smoke-test installation from outside the monorepo (`npx create-kora-app@beta my-app`, and
`npx kora upgrade --to 1.0.0-beta.15` in a beta.14 app), tag the released commit and push the tag:

```bash
git tag v1.0.0-beta.15
git push origin v1.0.0-beta.15
```

Finally:

1. Publish the GitHub security advisory, then replace the `GHSA-xxxx-xxxx-xxxx` and CVSS
   placeholders in the advisory and link it from the release notes.
2. Remove the "Draft. Not published." notes from the release notes, the advisory and the upgrade
   guide, and record the verification results in the notes.
3. Create the GitHub release from the release notes.

## Troubleshooting

| Symptom | Action |
|---------|--------|
| `E403` / `E402` for `@korajs/*` | Confirm npm organization membership, publish rights, and 2FA configuration. |
| `E404` during publish | Run `npm whoami`; an unpublished scoped version can also appear as `E404` without valid auth. |
| A package is skipped | Compare its local version with `npm view <package> versions --json`. |
| A publish partially succeeds | Verify every package individually, then rerun only through Changesets; already-published versions will be skipped. |
| A packed manifest contains `workspace:` | Stop the release and fix packaging; `pnpm release:dry-run` is expected to catch this. |
| `kora upgrade` reports `UPGRADE_TAG_MISMATCH` | A dist-tag points at different versions across packages (a half-published release, or `latest` moved for some packages only). Finish the publish or align the tags. |

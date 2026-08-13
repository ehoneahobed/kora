---
title: npm Publish Checklist
description: "The maintainer checklist for validating, publishing, and verifying a Kora.js release on npm."
---

# npm publish checklist — 1.0.0-beta.11

Use this checklist with the [beta.11 release notes and sign-off](./v1.0.0-beta.11.md).
The manifests are already versioned for beta.11; do **not** run `pnpm beta:bump`,
`pnpm beta:release`, or `pnpm changeset version` for this release.

## Pre-publish gates

Run from the repository root on the exact commit that will be released:

```bash
pnpm install --frozen-lockfile
pnpm test:pre-release
pnpm release:dry-run
```

`release:dry-run` builds and locally packs every publishable workspace package. It verifies the
packed manifests, resolves `workspace:` dependencies, and checks declared entry points without
contacting or writing to the npm registry.

Expected publish set: 15 packages. The 13 linked packages are `1.0.0-beta.11`,
`create-kora-app` is `0.1.25-beta.10`, and `@korajs/tauri` is `0.4.3-beta.10`.

## Publish

Choose exactly one publishing path. A push to `main` triggers
[the release workflow](../../.github/workflows/release.yml), so do not run a local publish at the
same time.

### Option A — GitHub Actions (recommended)

1. Commit the release changes on a branch, open a pull request, and ensure CI is green.
2. Confirm the repository `NPM_TOKEN` can publish `@korajs/*`.
3. Merge the exact reviewed commit to `main`.
4. Monitor the `release` workflow; with versions already prepared and changesets consumed in
   prerelease metadata, it runs `pnpm release` and publishes the package set.

### Option B — Local maintainer publish

Use this only when the automated release workflow will not publish the same commit.

1. Check out the exact reviewed, CI-green release commit.
2. Authenticate with an npm account that can publish `@korajs/*` and confirm it with:

   ```bash
   npm whoami
   ```

3. Re-run the safe package validation:

   ```bash
   pnpm release:dry-run
   ```

4. Publish through Changesets:

   ```bash
   pnpm release
   ```

The repository is in Changesets prerelease mode with tag `beta`, so prerelease packages are
published under npm's `beta` dist-tag. Complete any npm two-factor authentication prompt; do not
retry blindly if the command reports a partial publish.

## Verify

Check the primary package, dist-tags, and each version in the publish set:

```bash
npm view korajs@1.0.0-beta.11 version
npm view korajs dist-tags
npm view @korajs/auth@1.0.0-beta.11 version
npm view @korajs/cli@1.0.0-beta.11 version
npm view @korajs/core@1.0.0-beta.11 version
npm view @korajs/devtools@1.0.0-beta.11 version
npm view @korajs/merge@1.0.0-beta.11 version
npm view @korajs/react@1.0.0-beta.11 version
npm view @korajs/server@1.0.0-beta.11 version
npm view @korajs/store@1.0.0-beta.11 version
npm view @korajs/svelte@1.0.0-beta.11 version
npm view @korajs/sync@1.0.0-beta.11 version
npm view @korajs/test@1.0.0-beta.11 version
npm view @korajs/vue@1.0.0-beta.11 version
npm view create-kora-app@0.1.25-beta.10 version
npm view @korajs/tauri@0.4.3-beta.10 version
```

Then smoke-test installation from outside the monorepo, tag the released commit, push the tag,
and create the GitHub release from the beta.11 release notes:

```bash
git tag v1.0.0-beta.11
git push origin v1.0.0-beta.11
```

## Troubleshooting

| Symptom | Action |
|---------|--------|
| `E403` / `E402` for `@korajs/*` | Confirm npm organization membership, publish rights, and 2FA configuration. |
| `E404` during publish | Run `npm whoami`; an unpublished scoped version can also appear as `E404` without valid auth. |
| A package is skipped | Compare its local version with `npm view <package> versions --json`. |
| A publish partially succeeds | Verify every package individually, then rerun only through Changesets; already-published versions will be skipped. |
| A packed manifest contains `workspace:` | Stop the release and fix packaging; `pnpm release:dry-run` is expected to catch this. |

## Future releases

After beta.11, use the normal Changesets flow or merge the Version Packages PR created by
[the release workflow](../../.github/workflows/release.yml):

```bash
pnpm changeset
pnpm changeset version
pnpm test:pre-release
pnpm release:dry-run
pnpm release
```

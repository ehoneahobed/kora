# npm publish checklist — 1.0.0-beta.12

1. Confirm the release branch is clean and the package versions are `1.0.0-beta.12`
   (`create-kora-app` and `@korajs/tauri` retain their independent base versions).
2. Run `pnpm test:pre-release` and require every lint, build, unit, type, production-path,
   reconnect, chaos, benchmark, browser-install, and E2E gate to pass.
3. Run `pnpm release:dry-run` and inspect the complete publish set and tarball contents.
4. Confirm `npm whoami`, then publish with `pnpm -r publish --tag beta --no-git-checks`.
5. Verify `npm view korajs@1.0.0-beta.12 version`, each scoped package, and the `beta` dist-tags.
6. Tag the exact published commit with `git tag v1.0.0-beta.12`, push the tag, publish the GitHub
   release from [the beta.12 notes](./v1.0.0-beta.12.md), and merge the release pull request.

Never move the stable `latest` dist-tag as part of this beta release.

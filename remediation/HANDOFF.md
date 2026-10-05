# Remediation handoff (live state)

Update this file at every milestone. A fresh session should read it first, then `remediation/STATUS.md`.

**Last updated:** 2026-10-05 (released)

## Release status: RELEASED

**1.0.0-beta.13 shipped on 2026-10-05.**

- **npm:** all 15 packages published under the `beta` dist-tag: the 13 linked packages at `1.0.0-beta.13`, `create-kora-app` `0.1.25-beta.12`, `@korajs/tauri` `0.4.3-beta.12`. `latest` still points at `0.6.1` (affected; no stable patch).
- **Public repo:** `ehoneahobed/kora` `main` fast-forwarded from beta.12 (`91c6350`) to `c9003b4` (the private PR #4 merge); annotated tag `v1.0.0-beta.13` points at `c9003b4`. The public `release` workflow ran and published nothing (versions already on npm); `canary` skipped publishing.
- **Advisory:** [GHSA-v63m-pq3j-7m44](https://github.com/ehoneahobed/kora/security/advisories/GHSA-v63m-pq3j-7m44), published 2026-10-05 (Critical, `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N`).
- **Gate on the released commit:** cloud gate 223/223 fixed, 0 errors; maintainer machine `pnpm test:pre-release` green (Node 20; `better-sqlite3` native module built by hand, see follow-ups); install smoke test from the public registry passed.

## Release facts

- Last release before this one: 1.0.0-beta.12 (tag `v1.0.0-beta.12`, commit 91c6350). Commit 33bca46 (the Phase 1 merge) was never released.
- The private repo `ehoneahobed/kora-private` (remote `private`) held the security work until release. Everything is public now; new work happens on the public repo.

## Post-release follow-ups (none urgent)

1. Close public PR #7 "Version Packages (beta)" without merging and delete the public `changeset-release/main` branch (stale; would rewrite shipped versions).
2. Optional: `npm deprecate` affected versions (`<1.0.0-beta.13`) of `korajs`, `@korajs/server`, `@korajs/auth`, `@korajs/sync`, `@korajs/store` with a link to the advisory.
3. Create the GitHub release for `v1.0.0-beta.13` from `docs/releases/v1.0.0-beta.13.md` (pre-release) if not done yet.
4. Fix the `benchmark-gates` and `chaos-nightly` workflows, which fail immediately on every push (pre-existing since beta.12; a workflow configuration problem, not a test failure).
5. Add a root `pnpm.onlyBuiltDependencies` (at least `better-sqlite3`) and a `.nvmrc` (Node 20) so fresh clones build native modules without manual steps; move the ignored `examples/full-stack` `onlyBuiltDependencies` to the root.
6. Archive `kora-private` and delete its `wip/*` branches once comfortable.
7. Review the maintainer's parked local branch `local/scoped-delivery-wip` (built on beta.12; touches files the remediation rewrote) against beta.13.
8. Open items carried in the tracker: real Android device run for the leader-tab freeze path; browser insert of 10,000 rows slower than the 2 s target (reported, not gated).

## History before release

## Where things are

| Phase | State | Merged to private main |
|---|---|---|
| 1 Trust boundary | done, 3 red-team rounds | yes (PR #1) |
| 2 No silent loss | done, 3 red-team rounds | yes (PR #2) |
| 3 One fold, durability, protocol v2 | done, 4 red-team rounds | yes (PR #3) |
| 4 Encryption, types, DX, docs, beta.12 compatibility | done on `fix/phase4-rc`: final RC red team (RT-95..RT-104) fixed, migrate rebuild (RT-105, RT-106) fixed, final docs pass (DX-3) merged; final gate green (216/216) | no (PR open) |

## Phase 4 release-candidate line (`fix/phase4-rc`, pushed to `private`, head 6c28473)

- Phase 4 integration: ENC-1 key ring (D4b), W11 types (DX-1, DX-2), W12 runtime DX, tooling (NEW-DX-3 offline app shell, NEW-SRV-8 static server, DX-8, SYNC-9, NEW-DX-2, NEW-SRV-1, RT-30), RT-88, RT-89.
- Documentation audit (DX-3) and the beta.13 renumbering.
- beta.12 compatibility track: RT-90..RT-94, `scripts/remediation/compat-beta12.mjs`, `compat-beta12-browser.mjs`, `remediation/evidence/compat-beta12.md`.
- Final RC red team findings RT-95..RT-104 (merge 85b307f) and their fixes:
  - RT-95/96/97/104 (merge from `wip/phase4/worktree-agent-a3a77c4ad29039205`, head 3e3e759): key record format 2 (authenticated, forward-only by revision), recovery key anchored to the keyring (`kora-rk2-`), ring merge for rotation racing a passphrase change, `app.encryption.startNewKeyring()`, key records in server backups.
  - RT-98..RT-103 (merge from `wip/phase4/worktree-agent-a7ac0400012aa60c1`, head cdba4eb): one records-changed funnel to the cross-tab bus, content-derived static validators, include() typing, value domain enforced at write time with beta.12 enum CHECK / NOT NULL relaxed once (client and server), `kora migrate` relax step, one query key, refusing transforms that cannot read the stored log.
- RT-105/RT-106 (merge from `wip/phase4/migrate-rebuild`, head a924106): `kora migrate` uses a `--kora:evolve-table` step that keeps Kora's internal columns, foreign keys and indexes and works on Postgres; server stores write the schema default for fields added later.
- Final documentation pass (merge from `wip/phase4/docs-final`, head dd8faa9): every page audited against the code, `pnpm docs:check-code` (327 blocks, signature checks against real exports), CLAUDE.md reconciled with the source, `docs/guide/upgrading-to-beta13.md`; DX-3 fixed.
- Test hygiene: RT-97 property test with a fixed seed; hang-guard timeouts for the CLI suite and the studio lab setup (timeouts under load, not product bugs).
- Release documents: `remediation/BETA13-RELEASE-NOTES.md` (single note for Phases 1 to 4), `remediation/SECURITY-ADVISORY-DRAFT.md` (affected beta.12 and earlier, fixed in 1.0.0-beta.13).

Backups on `private` as `wip/phase4/<branch>` (integrated already; keep for reference): `worktree-agent-a53967623c7acbe52` (ENC-1), `worktree-agent-a95db974394a6531a` (runtime DX), `worktree-agent-ab1bb0a2a25664912` (tooling), `worktree-agent-ae1a9425c3ef70940` (types), plus the two RC fix branches above (merged).

## Open follow-ups (none block the release)

- RT-104 residuals: a brand-new device cannot detect an older key-record revision it never saw (documented); the "encrypted history exists" signal samples stored ops.
- RT-101 residual: in-place field type changes unsupported; Postgres column types never change.
- Optional performance: the OPFS database uses SQLite's default DELETE journal (documented). A Phase 4 runtime track measured TRUNCATE at 9-15 ms per commit vs 15-17 ms; it was not integrated. Browser insert of 10,000 rows takes 7.5-9.3 s against a 2 s target (reported, not gated).
- Android background freeze of a leader tab is verified only with simulated events; a real-device run is pending.

## PR #4 review (Codex, 2026-10-05)

Four automated review comments, each reproduced with a failing test, then fixed (branch `wip/phase4/codex-review`, merged into `fix/phase4-rc` at de5ad2b; replies posted on the PR):
- RT-110 (P1): backup restore now applies a newer revision of an encryption key record instead of keeping a stale one (memory, SQLite, Postgres).
- RT-111 (P2): relaxing beta.12 enum checks keeps hand-written CHECK constraints (client adapters, SQLite server, `kora migrate` rebuild).
- RT-112 (P2): the static server serves files only when their real path is inside the real `staticDir` (symlink escapes return 404).
- RT-113 (P2): `op.*` helpers are typed by operation and operand.

Gate on 2164373: build, biome, typecheck, root test 30/30, `check.mjs --all` 223/223 fixed, 0 errors, 0 warnings, e2e 11/11.

## Next steps

Follow `docs/releases/npm-publish-checklist-beta.13.md` exactly, in one sitting:

1. Maintainer: delete the stale `changeset-release/main` branch in `kora-private`, then merge PR #4 (`fix/phase4-rc`, which now includes the release prep) into private `main`. The `release` and `canary` workflows only run in the public repo (`if: github.repository == 'ehoneahobed/kora'`), so the merge cannot publish from the private copy.
2. On the maintainer machine at that merge commit: `pnpm install --frozen-lockfile`, `pnpm test:pre-release` (optional `KORA_PG_TEST_URL`; installs Playwright Chromium), `pnpm release:dry-run`.
3. `npm whoami`, `pnpm -r publish --tag beta --no-git-checks`, verify every package and dist-tag, smoke-test outside the monorepo.
4. Only then: fast-forward public `origin` `main` to the merge commit, tag `v1.0.0-beta.13`, publish the GitHub Security Advisory (request a CVE) and the GitHub release.
5. Decide on the unpatched 0.x `latest` line (deprecate or leave; runbook step f.3).

## Working rules

- Commit and push to `private` after every merge or milestone; update this file and `STATUS.md` as you go. Agents push their own branch to `private` as `wip/phase4/<branch>` after every item.
- Gate script: `scratchpad/main-gate.sh` (read-only). Agents must never edit scratchpad `.sh` files.
- Postgres for the gate: `su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pgrem -o '-p 54350 -k /tmp' -l /tmp/pgrem.log start"`, `KORA_PG_TEST_URL=postgres://postgres@127.0.0.1:54350/postgres`.
- beta.12 build for the probes: `git archive v1.0.0-beta.12`, extract, `pnpm install --frozen-lockfile && pnpm build`.
- Chromium: `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium`. Never run `playwright install`.
- After interrupting agents, commit their worktrees' uncommitted changes and push them as `wip/phase4/<branch>`, then kill leftover processes (vitest, turbo, Postgres clusters).

# Remediation handoff (live state)

Update this file at every milestone. A fresh session should read it first, then `remediation/STATUS.md` on branch `fix/phase4-rc`.

**Last updated:** 2026-10-04

## Release facts (from the maintainer)

- The last published release is **1.0.0-beta.12** (tag `v1.0.0-beta.12`, commit 91c6350).
- Phases 1 to 4 all ship together as **1.0.0-beta.13**. There is no beta.14. Commit 33bca46 (the Phase 1 merge) was never released.
- The only old clients and servers in the field are beta.12 and older. Compatibility tests must target beta.12.
- Security-sensitive work stays in the private repo `ehoneahobed/kora-private` (remote `private`) until beta.13 ships with the advisory. Never push to the public `origin`.

## Where things are

| Phase | State | Merged to private main |
|---|---|---|
| 1 Trust boundary | done, 3 red-team rounds | yes (PR #1) |
| 2 No silent loss | done, 3 red-team rounds | yes (PR #2) |
| 3 One fold, durability, protocol v2 | done, 4 red-team rounds | yes (PR #3) |
| 4 Encryption, types, DX, docs, beta.12 compatibility | done on `fix/phase4-rc`; final RC red team run (RT-95..RT-104) and all ten fixed; final gate running | no |

## Phase 4 release-candidate line (`fix/phase4-rc`, pushed to `private`, head 66eae5d)

- Phase 4 integration: ENC-1 key ring (D4b), W11 types (DX-1, DX-2), W12 runtime DX, tooling (NEW-DX-3 offline app shell, NEW-SRV-8 static server, DX-8, SYNC-9, NEW-DX-2, NEW-SRV-1, RT-30), RT-88, RT-89.
- Documentation audit (DX-3) and the beta.13 renumbering.
- beta.12 compatibility track: RT-90..RT-94, `scripts/remediation/compat-beta12.mjs`, `compat-beta12-browser.mjs`, `remediation/evidence/compat-beta12.md`.
- Final RC red team findings RT-95..RT-104 (merge 85b307f) and their fixes:
  - RT-95/96/97/104 (merge from `wip/phase4/worktree-agent-a3a77c4ad29039205`, head 3e3e759): key record format 2 (authenticated, forward-only by revision), recovery key anchored to the keyring (`kora-rk2-`), ring merge for rotation racing a passphrase change, `app.encryption.startNewKeyring()`, key records in server backups.
  - RT-98..RT-103 (merge from `wip/phase4/worktree-agent-a7ac0400012aa60c1`, head cdba4eb): one records-changed funnel to the cross-tab bus, content-derived static validators, include() typing, value domain enforced at write time with beta.12 enum CHECK / NOT NULL relaxed once (client and server), `kora migrate` relax step, one query key, refusing transforms that cannot read the stored log.
- Release documents: `remediation/BETA13-RELEASE-NOTES.md` (single note for Phases 1 to 4), `remediation/SECURITY-ADVISORY-DRAFT.md` (affected beta.12 and earlier, fixed in 1.0.0-beta.13).

Backups on `private` as `wip/phase4/<branch>` (integrated already; keep for reference): `worktree-agent-a53967623c7acbe52` (ENC-1), `worktree-agent-a95db974394a6531a` (runtime DX), `worktree-agent-ab1bb0a2a25664912` (tooling), `worktree-agent-ae1a9425c3ef70940` (types), plus the two RC fix branches above (merged).

## Open follow-ups noted by the last fix engineers (not yet tracked)

- `kora migrate` full table rebuild (field add/remove) drops `_version` and `_field_versions` columns (pre-existing). Must be checked against the Phase 3 fold state (`_kora_fold_state`): if merge metadata is lost, file and fix before release.
- RT-104 residuals: a brand-new device cannot detect an older key-record revision it never saw (documented); the "encrypted history exists" signal samples stored ops.
- RT-101 residual: in-place field type changes unsupported; Postgres column types never change.
- DX-3 shows "looks fixed": set to fixed after the final documentation pass.

## Next steps

1. Final gate on head 66eae5d (running at last update): build, biome, typecheck, root test, `check.mjs --all` with PG16 + Chromium + `LMS_OPS=20000`, e2e, chaos, beta.12 compat scripts.
2. Investigate the `kora migrate` rebuild follow-up above.
3. Final documentation pass (every guide and API page matches the code); set DX-3 fixed.
4. Commit `STATUS.md`, push, update Project docs, open the PR into private main.
5. Release: publish 1.0.0-beta.13 together with the advisory.

## Working rules

- Commit and push to `private` after every merge or milestone; update this file and `STATUS.md` as you go. Agents push their own branch to `private` as `wip/phase4/<branch>` after every item.
- Gate script: `scratchpad/main-gate.sh` (read-only). Agents must never edit scratchpad `.sh` files.
- Postgres for the gate: `su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pgrem -o '-p 54350 -k /tmp' -l /tmp/pgrem.log start"`, `KORA_PG_TEST_URL=postgres://postgres@127.0.0.1:54350/postgres`.
- beta.12 build for the probes: `git archive v1.0.0-beta.12`, extract, `pnpm install --frozen-lockfile && pnpm build`.
- Chromium: `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium`. Never run `playwright install`.
- After interrupting agents, commit their worktrees' uncommitted changes and push them as `wip/phase4/<branch>`, then kill leftover processes (vitest, turbo, Postgres clusters).

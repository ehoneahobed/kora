# Remediation handoff (live state)

Update this file at every milestone. A fresh session should read it first, then `remediation/STATUS.md`.

**Last updated:** 2026-10-04

## Release facts (from the maintainer)

- The last published release is **1.0.0-beta.12** (tag `v1.0.0-beta.12`, commit 91c6350).
- Phases 1 to 4 all ship together as **1.0.0-beta.13**, the only release after beta.12; the next release after it is unplanned. Commit 33bca46 (the Phase 1 merge) was never released.
- The only old clients and servers in the field are beta.12 and older. Compatibility tests must target beta.12.
- Security-sensitive work stays in the private repo `ehoneahobed/kora-private` (remote `private`) until beta.13 ships with the advisory. Never push to the public `origin`.

## Where things are

| Phase | State | Merged to private main |
|---|---|---|
| 1 Trust boundary | done, 3 red-team rounds | yes (PR #1) |
| 2 No silent loss | done, 3 red-team rounds | yes (PR #2) |
| 3 One fold, durability, protocol v2 | done, 4 red-team rounds | yes (PR #3) |
| 4 Encryption, types, DX, docs, beta.12 compatibility | merged on `fix/phase4-rc` line, gate green; final RC red team pending | no |

## Phase 4 release-candidate line

Merged into `fix/phase4-rc` and pushed to `private` (head 6dcb5e2 plus this update):
- The Phase 4 integration line: ENC-1 key ring (D4b), W11 types (DX-1, DX-2), W12 runtime DX (STORE-11, STORE-12, NEW-STORE-4, DX-4..DX-9, NEW-DX-1, SEC-7, SEC-9b, NEW-STORE-11, STORE-16), tooling (NEW-DX-3 offline app shell, NEW-SRV-8 static server, DX-8, SYNC-9, NEW-DX-2, NEW-SRV-1, RT-30), RT-88 and RT-89.
- The documentation audit (DX-3) and the beta.13 release renumbering.
- **The beta.12 compatibility track** (merge c956952, from local branch `worktree-agent-a87b3402ab69d1db7` through a7f04d0; the `private` wip copy stops at 60dc837 without the RT-90..RT-94 renumbering): RT-90 Date-in-json version-1 ids, RT-91 legacy anonymous claims on beta.12 server databases, RT-92 local node registry seeding, RT-93/RT-94 provisional cascades settling while streaming; `scripts/remediation/compat-beta12.mjs`, `compat-beta12-browser.mjs`, `remediation/evidence/compat-beta12.md`. All code conflicts were comment wording; both lines' behaviour is kept.
- Release documents: `remediation/BETA13-RELEASE-NOTES.md` is the single beta.13 note for Phases 1 to 4 (the Phase 3/4 draft notes are folded in and deleted); `remediation/SECURITY-ADVISORY-DRAFT.md` says affected beta.12 and earlier, fixed in 1.0.0-beta.13.

Backups on `private` as `wip/phase4/<branch>` (do not merge unless the line is found lacking): `worktree-agent-a53967623c7acbe52` (ENC-1), `worktree-agent-a95db974394a6531a` (runtime DX), `worktree-agent-ab1bb0a2a25664912` (tooling), `worktree-agent-ae1a9425c3ef70940` (types). The compat track wip branch is now merged.

## Gate results (2026-10-04, after the compat merge)

| Check | Result |
|---|---|
| `pnpm build` | 16/16 (docs build fixed: three dead links to internal pages) |
| `npx biome check packages kora scripts` | clean |
| `npx turbo run typecheck` | 27/27 |
| root `pnpm test` | 30/30 tasks |
| `check.mjs --all` (PG16, Chromium, `LMS_OPS=20000`) | 203/204 fixed, 0 errors, 1 warning: DX-3 "looks fixed" (left open for step 2 below) |
| e2e (`kora-e2e test:e2e`) | 11/11 |
| `pnpm chaos:nightly` | pass (chaos 1/1, invariants 11/11) |
| `compat-beta12.mjs` (real beta.12 build, Postgres) | 24/24 scenarios ok |
| `compat-beta12-browser.mjs` | 2/2 ok (SQLite WASM/OPFS, IndexedDB) |
| `protocol-v2-compat.mjs`, `rt-legacy-id-probe.mjs`, `rt3-legacy-probe.mjs`, `rt3-upgrade-clear-probe.mjs` | all converged, no rejections |

## Next steps

0. **Final RC red team done (2026-10-04): see `remediation/evidence/redteam-rc.md`.** RT-95..RT-104 are open (P1: RT-95, RT-97, RT-101, RT-104; P2: RT-96, RT-98, RT-99, RT-102, RT-103; P3: RT-100); fix them by root cause before the release.
1. **Final release-candidate red team** over all of Phase 4 (encryption key ring, types, runtime DX, tooling, the beta.12 compatibility fixes RT-90..RT-94) and the late Phase 3 changes (transforms at fold time, value domain); fix its findings by root cause, with repros in the tracker.
2. Final documentation pass for anything changed after the audit; then set DX-3 to fixed.
3. Re-run the gate, commit `STATUS.md`, push to `private`, update the Project docs, open the PR.
4. Release: publish 1.0.0-beta.13 together with the advisory.

## Working rules

- Commit and push to `private` after every merge or milestone; update this file and `STATUS.md` as you go.
- Gate script: `scratchpad/main-gate.sh` (read-only copy). Agents must never edit scratchpad `.sh` files.
- Postgres for the gate: `su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pgrem -o '-p 54350 -k /tmp' -l /tmp/pgrem.log start"`, `KORA_PG_TEST_URL=postgres://postgres@127.0.0.1:54350/postgres`. (Worktree-isolated agents cannot run `su`; they start their own cluster on another port with a launcher that drops to the postgres uid.)
- beta.12 build for the probes: `git archive v1.0.0-beta.12`, extract, `pnpm install --frozen-lockfile && pnpm build`.
- Chromium: `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium`. Never run `playwright install`.
- After interrupting agents, kill their leftover processes (vitest, turbo, Postgres clusters) or the machine stalls.

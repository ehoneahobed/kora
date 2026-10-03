# Remediation handoff (live state)

Update this file at every milestone. A fresh session should read it first, then `remediation/STATUS.md`.

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
| 4 Encryption, types, DX, docs | in progress on `fix/phase4-rc` | no |

## Phase 4 branch `fix/phase4-rc` (pushed to `private`)

Merged so far:
- The Phase 4 integration line from the 2026-10-03 run: ENC-1 key ring (D4b), W11 types (DX-1, DX-2), W12 runtime DX (STORE-11, STORE-12, NEW-STORE-4, DX-4..DX-9, NEW-DX-1, SEC-7, SEC-9b, NEW-STORE-11, STORE-16), tooling (NEW-DX-3 offline app shell, NEW-SRV-8 static server, DX-8, SYNC-9, NEW-DX-2, NEW-SRV-1, RT-30), RT-88 and RT-89 fixes.
- The documentation audit (every guide and API reference checked against the code, DX-3) and the beta.13 release renumbering.

Not merged yet (saved on `private` as `wip/phase4/<branch>`):
- `wip/phase4/worktree-agent-a87b3402ab69d1db7`: **beta.12 compatibility track, needed.** Renumbered to RT-90..RT-94 (commit a7f04d0). Probes re-pointed to the real beta.12 build, legacy-path fixes, `remediation/evidence/compat-beta12.md`. Merging it into `fix/phase4-rc` conflicts in about 30 files: mostly beta.13/beta.14 wording that both lines rewrote, plus legacy-path code (`client-session.ts`, `duplicate-identity.ts`, `legacy-bodies.ts`, `local-sync-records.ts`, `sync-engine.ts`, `verify-inbound.ts`, `fold.ts`) and the probe scripts. Resolve keeping both lines' behaviour; the integration line wins on wording.
- Duplicates from the 2026-10-04 rerun, kept only as backups (do not merge unless the integration line is found lacking): `worktree-agent-a53967623c7acbe52` (ENC-1), `worktree-agent-a95db974394a6531a` (runtime DX), `worktree-agent-ab1bb0a2a25664912` (tooling), `worktree-agent-ae1a9425c3ef70940` (types).

## Next steps

1. Merge the beta.12 compatibility track into `fix/phase4-rc` (resolve conflicts as above).
2. Run the full gate (build, `npx biome check packages kora scripts`, `npx turbo run typecheck`, root `pnpm test`, `node scripts/remediation/check.mjs --all` with Postgres and Chromium, e2e) and fix failures.
3. Consolidate `remediation/BETA14-NOTES-DRAFT.md` into `remediation/BETA13-RELEASE-NOTES.md` (one beta.13 release covering Phases 1 to 4), then delete the draft. Update `remediation/SECURITY-ADVISORY-DRAFT.md` to match.
4. Final documentation pass for anything changed after the audit.
5. Final release-candidate red team over all of Phase 4 and the late Phase 3 changes (transforms at fold time, value domain), then fix its findings.
6. Commit `STATUS.md`, push, update the Project docs, open the PR.

## Working rules

- Commit and push to `private` after every merge or milestone; update this file and `STATUS.md` as you go.
- Gate script: `scratchpad/main-gate.sh` (read-only copy). Agents must never edit scratchpad `.sh` files.
- Postgres for the gate: `su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pgrem -o '-p 54350 -k /tmp' -l /tmp/pgrem.log start"`, `KORA_PG_TEST_URL=postgres://postgres@127.0.0.1:54350/postgres`.
- Chromium: `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium`. Never run `playwright install`.
- After interrupting agents, kill their leftover processes (vitest, turbo, Postgres clusters) or the machine stalls.

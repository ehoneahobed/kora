# Remediation programme

This folder tracks the fix programme for the 106 verified defects found in the October 2026
review of Kora 1.0.0-beta.12 (first review plus the LMS team intake). One of them, SEC-9, is
tracked as two parts, so the tracker has 107 entries. Nothing here is aspirational: every entry
is backed by a reproduction test that fails today and must pass when the fix lands, and CI
enforces it.

| File | What it is |
|---|---|
| `tracker.json` | One entry per problem: severity, workstream, phase, status, PR, and the tests that prove it. **The source of truth.** |
| `baseline.json` | Every repro result at the start (commit recorded inside). Decides which tests are repro tests (failing) and which are guards (passing). |
| `STATUS.md` | Generated progress report. Never edit by hand. |
| `evidence/` | The plan (`kora-fix-plan.md`), the findings register, and every verification report with file:line evidence. |
| `SECURITY-ADVISORY-DRAFT.md` | Draft advisory for beta.12, to publish when beta.13 ships. |

The checker lives at `scripts/remediation/check.mjs`; CI runs it in `.github/workflows/remediation.yml`.

## Rules the checker enforces

1. A problem marked `fixed` must have **all** its repro tests passing, otherwise it is a **REGRESSION** and CI fails.
2. A **guard** test (passing at baseline) must keep passing. Guards pin behaviour that is already correct, and they include the tests proving rejected external proposals unsafe.
3. Every failing test under `tests/repro` must belong to a problem. Nothing can fail silently and unowned.
4. An `open` problem whose repro tests all pass is reported as **LOOKS FIXED**, so the tracker is updated in the same PR as the fix.
5. A problem cannot be marked `fixed` without a repro test or an acceptance test.

**Observation** tests describe today's (wrong) behaviour, for example "HEAD does not ping idle sockets". They are expected to flip once a fix lands. The checker reports the flip and does not fail; the fixing PR inverts or deletes them.

## Statuses

`open` → `in_progress` → `fixed`. Also:
- `mitigated`: a Phase 1 stopgap landed, but the structural fix is still to come. The `stopgap` block holds its own status.
- `wontfix`: needs a written reason in `notes` and the maintainer's sign-off.

## Workflow for every fix

1. **Pick** the problem(s) from `STATUS.md`, in phase order. Set `status: "in_progress"`.
2. **Read the evidence** in `evidence/` (search for the ID) and the design in `evidence/kora-fix-plan.md`.
3. **Run the failing tests** to see them fail. Use `node scripts/remediation/check.mjs --only packages/<pkg>`, or `KORA_REPRO=1 npx vitest run tests/repro/<ID>.test.ts` in the package.
4. **Fix by root cause**, following the workstream design. Keep the package's normal test suite green (`pnpm --filter <pkg> test`).
5. **Invert** any existing unit test that encoded the bug (listed in plan §4 W0 task 2), in the same PR.
6. **Add** unit tests next to the code you changed. Repro tests prove the defect is gone; unit tests prove the new code's contract.
7. **Set** `status: "fixed"` and `pr: "#123"` in `tracker.json`, then run `node scripts/remediation/check.mjs --all` and commit the regenerated `STATUS.md`.
8. **Open a PR** whose description lists the problem IDs, the repro tests that turned green, and any breaking change with its migration note.

## Commands

```bash
pnpm remediation              # node suites (fast), writes STATUS.md
pnpm remediation:all          # node + Postgres (if KORA_PG_TEST_URL) + real Chromium + tsc probes
node scripts/remediation/check.mjs --only packages/auth   # one package, fastest loop
```

Postgres tests need `KORA_PG_TEST_URL`. Browser suites need Chromium; set `PW_CHROMIUM_PATH` (CI resolves Playwright's).

## Why the repro tests are not in `pnpm test`

They fail by design until fixed. `vitest.shared.ts` excludes `**/tests/repro/**` unless `KORA_REPRO=1`, and every package's `tsconfig.json` excludes `tests/repro` from typecheck (the DX type probes contain deliberate type errors). The checker sets `KORA_REPRO=1` and runs them with the tracker's rules instead.

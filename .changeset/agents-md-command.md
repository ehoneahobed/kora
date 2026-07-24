---
"@korajs/cli": minor
---

Add a `kora agents-md` command that writes an AGENTS.md with Kora conventions
(data-plane rules, the corrected hook API, anti-patterns, and the machine-readable
docs endpoints) into an existing project. It detects the UI framework from the
project's dependencies, refuses to overwrite an existing file without `--force`,
and accepts a `--framework` override. This extends the guardrail that scaffolded
apps already ship to the manual-setup path.

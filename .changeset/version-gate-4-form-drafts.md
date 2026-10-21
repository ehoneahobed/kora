---
"@korajs/core": patch
"@korajs/react": patch
"@korajs/vue": patch
"@korajs/svelte": patch
"korajs": patch
---

Version gate, stage 4: form drafts. `useFormDraft(formKey, initial, { fields })` (React hook, Vue composable, Svelte store; `korajs/react`, `korajs/vue`, `korajs/svelte`) keeps what the user was typing across the reload a new build asks for. Opt-in per form: nothing is stored unless a form calls it, and only the listed `fields` are drafted (in `sessionStorage`, under `kora-draft:<db>:<formKey>`).

- Never drafted, even when listed: a field bound to a `type="password"` input (re-checked on change; a field that becomes one has its stored value removed), an input marked `data-kora-sensitive`, a `t.secret()` field of `collection` (nothing of such a form is drafted until the schema is known), and `sensitive` fields; `allowSensitive` overrides (discouraged).
- When the app enables encryption (`app.encryption`), no draft is stored at all: no plaintext copy, the form is simply not restored. (Decision for the design's deferred question; a sealed draft store may come later.)
- A restored draft is removed at once and rewritten only on the next change; `clear()` after a successful submit; `clearFormDrafts(dbName)` (from `korajs`) removes every draft of the database on sign-out or a user change, and a draft written under another `userId` is never restored.
- `app:before-build-reload` saves the latest values synchronously before `app.reloadForNewBuild()` reloads.

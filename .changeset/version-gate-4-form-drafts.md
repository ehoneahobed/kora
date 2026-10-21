---
"@korajs/core": patch
"@korajs/react": patch
"@korajs/vue": patch
"@korajs/svelte": patch
"korajs": patch
---

Version gate, stage 4: form drafts. `useFormDraft(formKey, initial, { fields })` (React hook, Vue composable, Svelte store; `korajs/react`, `korajs/vue`, `korajs/svelte`) keeps what the user was typing across the reload a new build asks for. Opt-in per form: nothing is stored unless a form calls it, and only the listed `fields` are drafted (in `sessionStorage`, under `kora-draft:<db>:<formKey>`).

- Never drafted, even when listed: a field bound to a password input (`type="password"`, or `autocomplete` `current-password` / `new-password` / `one-time-code` / `cc-*`; observed when the binding first sees the input and on every type change, not only at save, and once seen never drafted again in that form, so a "show password" toggle, even before the first keystroke, does not draft it), an input marked `data-kora-sensitive`, a `t.secret()` field of `collection` (nothing of such a form is drafted until the schema is known), and `sensitive` fields (a dotted path such as `answers.ssn` removes that nested value; sensitivity is otherwise per top-level field); `allowSensitive` overrides (discouraged). A `sensitive`, `allowSensitive` or `safe` entry that is not a listed field warns.
- Fail closed: the control is resolved at or inside the bound element (a component whose ref lands on a wrapper is read through it; any password control inside makes the field secret). A listed field with no resolvable `<input>` / `<textarea>` / `<select>` (values set from code, wrappers without a control) is not drafted unless listed in `safe`. `describeFormDraftInput()` (core bindings) is the shared resolver.
- When the app enables encryption (`app.encryption`), no draft is stored at all: no plaintext copy, the form is simply not restored. (Decision for the design's deferred question; a sealed draft store may come later.)
- A restored draft is removed at once and rewritten only on the next change; `clear()` after a successful submit; `clearFormDrafts(app)` (from `korajs`) removes every draft of the database on sign-out or a user change (with `namespaceByAuthUser`, of every namespace of the base name), and a draft written under another known `userId` is removed, never restored. `userId: undefined` means the session is still loading: nothing is restored, consumed or saved until the user is known, then the draft is restored (keeping what was typed meanwhile). Pass `null` when signed out. Vue accepts a ref or getter, Svelte a store or getter (or `draft.setUser()`).
- `app:before-build-reload` saves the latest values synchronously before `app.reloadForNewBuild()` reloads.

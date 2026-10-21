---
"@korajs/cli": patch
"@korajs/core": patch
---

Version gate, stage 5: every template drafts its new-task field with `useFormDraft` (React, Vue, Svelte; the only drafted field, cleared once the write is stored, kept when a write is refused), and the templates with sign-in pass the user only once the session has loaded (`userId: undefined` while it loads, so the reload's draft survives the session restore) and clear every draft on sign-out and when a known signed-in user changes, never on the first load (`clearFormDrafts(app)`, which now also accepts the app). New guide: [App updates and multiple tabs](https://korajs.dev/guide/app-updates) (deployments, build ids, the reload prompt and its states, frozen and background tabs, the beta.15 upgrade note, HTTPS and test environments, form drafts and their privacy rules); API pages for the new errors, events, `useFormDraft` and the Vite plugins.

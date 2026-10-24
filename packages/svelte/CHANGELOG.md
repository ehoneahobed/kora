# @korajs/svelte

## 1.0.0-beta.15

### Minor Changes

- 95f5a26: `useMutation` reports writes the sync server refuses. In React, Vue and Svelte, `useMutation(fn, { onRejected })` and a `rejected` state (`{ code, message, collection, recordId, operationId, operationIds, reverted, args }`) tell the component that made a write when the server permanently refuses it, even hours later after an offline period, so an app can show "this change was undone, and why" without listening to sync events. One `mutate()` call is one write: every operation it committed, including a delete's cascades and a whole `app.transaction()`; it is reported once. `reverted` is false only for the refusals the device keeps locally (`OUT_OF_UPLINK_SCOPE`, `NODE_ID_MISMATCH`, `SEQUENCE_CONFLICT`). Retriable rejections are not reported. A hook reports nothing after it unmounts, and tracks at most 500 unsynced writes; the app-level `sync:operation-rejected` event and `app.sync.getRejectedOperations()` still report every refusal. Tracking needs `<KoraProvider app={app}>`. Svelte's mutation also gains `subscribeRejected(fn)`.

  Two new sync events support it: `sync:operations-acknowledged` (`operationIds` the server stored) and `sync:operations-rewritten` (`reason`, `idMapping`: unsent operations re-authored under new ids by a clock rebase, a node-id rotation or a sequence renumbering).

### Patch Changes

- df7a430: Version gate, stage 4: form drafts. `useFormDraft(formKey, initial, { fields })` (React hook, Vue composable, Svelte store; `korajs/react`, `korajs/vue`, `korajs/svelte`) keeps what the user was typing across the reload a new build asks for. Opt-in per form: nothing is stored unless a form calls it, and only the listed `fields` are drafted (in `sessionStorage`, under `kora-draft:<db>:<formKey>`).

  - Never drafted, even when listed: a field bound to a password input (`type="password"`, or `autocomplete` `current-password` / `new-password` / `one-time-code` / `cc-*`; observed when the binding first sees the input and on every type change, not only at save, and once seen never drafted again in that form, so a "show password" toggle, even before the first keystroke, does not draft it), an input marked `data-kora-sensitive`, a `t.secret()` field of `collection` (nothing of such a form is drafted until the schema is known), and `sensitive` fields (a dotted path such as `answers.ssn` removes that nested value; sensitivity is otherwise per top-level field); `allowSensitive` overrides (discouraged). A `sensitive`, `allowSensitive` or `safe` entry that is not a listed field warns.
  - Fail closed: the control is resolved at or inside the bound element (a component whose ref lands on a wrapper is read through it; any password control inside makes the field secret). A listed field with no resolvable `<input>` / `<textarea>` / `<select>` (values set from code, wrappers without a control) is not drafted unless listed in `safe`. `describeFormDraftInput()` (core bindings) is the shared resolver.
  - When the app enables encryption (`app.encryption`), no draft is stored at all: no plaintext copy, the form is simply not restored. (Decision for the design's deferred question; a sealed draft store may come later.)
  - A restored draft is removed at once and rewritten only on the next change; `clear()` after a successful submit; `clearFormDrafts(app)` (from `korajs`) removes every draft of the database on sign-out or a user change (with `namespaceByAuthUser`, of every namespace of the base name), and a draft written under another known `userId` is removed, never restored. `userId: undefined` means the session is still loading: nothing is restored, consumed or saved until the user is known, then the draft is restored (keeping what was typed meanwhile). Pass `null` when signed out. Vue accepts a ref or getter, Svelte a store or getter (or `draft.setUser()`).
  - `app:before-build-reload` saves the latest values synchronously before `app.reloadForNewBuild()` reloads.

  Review round: a `userId` getter is followed (an account switch it reports resets the form and restores that user's draft; values are never stored under another user); the last known user is tracked across loading states (alice, loading, bob never carries Alice's input to Bob); fields typed while the session loads win over the restored draft; `clear()` and the automatic "back at the initial values" removal keep the stored draft while the user is unknown; `allowSensitive` overrides dotted sensitive paths (`answers` or `answers.ssn`); `clearFormDrafts(app)` takes the app as documented (or a database name); equality checks never throw on `bigint` or cyclic values (`formValuesEqual`); an ancestor gaining `data-kora-sensitive` is observed in every binding (React and Vue observe attributes React or Vue does not re-render for).

- Updated dependencies [24f5531]
- Updated dependencies [6c72c04]
- Updated dependencies [6fd998a]
- Updated dependencies [946dd42]
- Updated dependencies [8667762]
- Updated dependencies [003d7bf]
- Updated dependencies [0b461fa]
- Updated dependencies [8411be3]
- Updated dependencies [a5c61ff]
- Updated dependencies [714ebd2]
- Updated dependencies [4237195]
- Updated dependencies [180923d]
- Updated dependencies [fa1a971]
- Updated dependencies [c5ef367]
- Updated dependencies [6470e48]
- Updated dependencies [d19c7f7]
- Updated dependencies [95f5a26]
- Updated dependencies [89cb4c4]
- Updated dependencies [0b461fa]
- Updated dependencies [b378fb9]
- Updated dependencies [fe4d3cb]
- Updated dependencies [0388bd7]
- Updated dependencies [68cbb70]
- Updated dependencies [df7a430]
- Updated dependencies [b7f964a]
  - @korajs/core@1.0.0-beta.15
  - @korajs/sync@1.0.0-beta.15
  - @korajs/store@1.0.0-beta.15

## 1.0.0-beta.14

### Patch Changes

- a0965d3: Rich-text controller never drops local edits. Saves write the full live Y.Doc instead of a base
  snapshot plus tracked deltas, so a stored change arriving during the save debounce no longer
  discards the waiting typing. A refused save keeps the edits in the document; the next edit or the
  new `retrySave()` saves them, and the first successful save clears `error`. Edits still waiting
  when the editor is destroyed are saved. New `hasUnsavedChanges` and `getUnsavedState()` (for a
  recovery copy) on the controller and on `useRichText` in React, Vue and Svelte. Saves run one at
  a time.
- Updated dependencies [afe97c6]
- Updated dependencies [99cedc4]
- Updated dependencies [8b7de83]
- Updated dependencies [4ec1bc5]
- Updated dependencies [44ddf65]
- Updated dependencies [a1e5765]
- Updated dependencies [a0965d3]
- Updated dependencies [88654fa]
  - @korajs/store@1.0.0-beta.14
  - @korajs/sync@1.0.0-beta.14
  - @korajs/core@1.0.0-beta.14

## 1.0.0-beta.13

### Minor Changes

- Query stores accept a readable query and follow it; queries share the canonical `queryKey` and
  report errors.

See the [1.0.0-beta.13 release notes](https://github.com/ehoneahobed/kora/blob/main/docs/releases/v1.0.0-beta.13.md) and the [upgrade guide](https://github.com/ehoneahobed/kora/blob/main/docs/guide/upgrading-to-beta13.md) (servers first, then clients).

## 1.0.0-beta.9

### Patch Changes

- Updated dependencies [b657130]
  - @korajs/core@1.0.0-beta.9
  - @korajs/store@1.0.0-beta.9
  - @korajs/sync@1.0.0-beta.9

## 1.0.0-beta.6

### Patch Changes

- Updated dependencies
  - @korajs/store@1.0.0-beta.6

## 1.0.0-beta.5

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @korajs/sync@1.0.0-beta.5
  - @korajs/store@1.0.0-beta.5
  - @korajs/core@1.0.0-beta.5

## 1.0.0-beta.0

### Patch Changes

- Package export hygiene and auth secret-handling hardening.

  - Every published package now exposes `./package.json` in its `exports` map. Previously `require.resolve('@korajs/core/package.json')` (and the same for every other package) failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, which breaks tooling that reads a package's manifest or version at runtime.
  - `createKoraAuthServer` now warns loudly when it falls back to an ephemeral random JWT secret outside production, so a deployment that never set `NODE_ENV=production` no longer silently regenerates its signing key on every restart (which invalidates all existing tokens) without any signal.
  - `KORA_AUTH_SECRET` set to an empty or whitespace-only string is now treated as unset rather than as an invalid secret, so it triggers the intended dev fallback / production guard instead of crashing `TokenManager` with a "secret too short" error.

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @korajs/store@1.0.0-beta.0
  - @korajs/core@1.0.0-beta.0
  - @korajs/sync@1.0.0-beta.0

## 0.6.1

### Patch Changes

- Updated dependencies [5d2afa8]
  - @korajs/sync@0.6.1

## 0.6.0

### Minor Changes

- Public beta 0.6.0: Vue 3 and Svelte 5 bindings with shared QueryStore, sync-status controller, and richtext controller; `@korajs/core/bindings` shared types; `@korajs/auth` org hooks and providers for React/Vue/Svelte; presence/collaboration hooks; CLI scaffolds; `korajs/vue` and `korajs/svelte` meta-package re-exports; Svelte component precompile and KoraProvider context bridge fix.

### Patch Changes

- Updated dependencies
  - @korajs/core@0.6.0
  - @korajs/store@0.6.0
  - @korajs/sync@0.6.0

## 0.5.0

### Minor Changes

- b909e5a: v0.5 internal beta: structured apply results and sync apply-failure events, audit trace export, benchmark gates in CI, release-gate script, and E2E fixture hardening (SQLite worker + local multi-tab Playwright project).

### Patch Changes

- Updated dependencies [b909e5a]
  - @korajs/core@0.5.0
  - @korajs/store@0.5.0

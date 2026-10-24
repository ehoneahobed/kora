---
title: App Updates and Multiple Tabs
description: "How Kora.js keeps two versions of an app from writing the same local database: build ids, the version gate, the reload prompt, and opt-in form drafts."
---

# App Updates and Multiple Tabs

Every tab of an app shares one local database. When you deploy a new version, a tab opened
before the deployment keeps running the old code next to a tab running the new one. Without
coordination, the old tab would keep writing with old code into data the new build may already
have changed. Kora's **version gate** makes sure only one build writes a database at a time, and
that the switch loses none of the user's work.

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
const schema = defineSchema({ version: 1, collections: { todos: { fields: { title: t.string() } } } })
declare function showUpdateBanner(onReload: () => void): void
declare const COMMIT_SHA: string
const app = createApp({ schema })
-->

## What happens during a deployment

1. A tab of the **new build** opens. It allocates its place in the order tabs opened (never from
   the clock) and lists every open tab of the app through Web Locks, including tabs that are idle.
2. Every **older** tab is told to retire. It shows _"A new version of this app is available.
   Reload to continue."_ first, and only then refuses new writes with `BuildSupersededError`
   (`BUILD_SUPERSEDED`). A write that had already started finishes; nothing is applied halfway.
3. The older tab saves everything it confirmed (the IndexedDB fallback flushes its snapshot), stops
   syncing for good (its unsent operations stay queued, and the new build uploads them; a
   connection attempt already in flight, such as an auth refresh, never opens a session), gives
   up the database, and releases its lock. From then on every `app.sync` call that connects or
   changes sync state (`connect`, `reconnect`, `retryNow`, `setQuerySubsets`,
   `clearRejectedOperations`, `assignHeld`, `discardHeld`) refuses with `BuildSupersededError`.
4. Only then does the new tab open storage and run its migrations. There is no timeout: if an older
   tab cannot let go (it is busy, its latest changes cannot be saved, or it was frozen while still
   opening or taking over the database), the new tab waits and tells the user
   (`store:build-gate-waiting`). It also waits for a storage leader of another build whose tab
   lock is already gone, so it never opens the database through an older build's worker.

After retiring, the old tab still reads (through the new build), but it never writes again. The
reload brings it onto the new build.

The later-opened build wins, so rolling a deployment back works too: reopening the app on the
previous build retires tabs of the withdrawn one. A release that changes Kora's storage format is
the exception: older code never opens a database a newer format wrote
(`StorageFormatAheadError`, `store:format-ahead`), so such a release cannot be rolled back by
redeploying the previous build.

## Build ids

The gate needs to tell two deployments apart. Templates already do this: the
`koraServiceWorker()` Vite plugin stamps a hash of the deployed files into every built page, and
`createApp()` reads it. For apps without the offline shell, add `koraBuildId()`:

<!-- docs-check: skip vite config file (vite is not a dependency of the docs workspace) -->
```typescript
// vite.config.ts
import { koraBuildId } from '@korajs/cli/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({ plugins: [react(), koraBuildId()] })
```

Or pass your own id (a commit SHA, a CI build number), which wins over the plugin's:

```typescript
const shaApp = createApp({ schema, build: COMMIT_SHA })
```

The id hashes every deployed file except the worker `koraServiceWorker()` generates, sourcemaps
(`.map`, which can differ between build machines for the same code), precompressed copies of
another emitted file (`app.js.gz` next to `app.js`) and dotfiles. A `sw.js` your app ships itself
and a standalone `.gz`/`.br` asset are hashed. Use one of the two plugins (`koraServiceWorker()`
includes `koraBuildId()`); with both, the tag is still injected once. A `kora-build` meta tag you
wrote yourself has its content replaced; every page of a multi-page build is stamped, and
precompressed copies of a page (`index.html.gz`, `.br`) are regenerated with the id. In `vite dev` the id is `dev-<start time>`: it changes on every restart of
the dev server, so tabs left open across a restart show the reload prompt.

Without either, Kora falls back to a fingerprint of the schema and reports
`store:build-unidentified`: a deployment that changes only application code is then **not**
gated. Kora never uses the `korajs` package version (two deployments of your app usually share it).

## The reload prompt

Kora shows a small banner by default. Replace it with your own UI in one of two ways; either way,
call `app.reloadForNewBuild()` when the user accepts:

```typescript
app.on('app:build-superseded', (event) => {
  event.preventDefault() // no default banner
  showUpdateBanner(() => app.reloadForNewBuild())
})
```

```typescript
const customApp = createApp({
  schema,
  store: {
    onBuildSuperseded: ({ newerBuild }) => {
      console.info(`build ${newerBuild} is open in another tab`)
      showUpdateBanner(() => customApp.reloadForNewBuild())
    },
  },
})
```

The announcement runs synchronously, before any write is refused. With the offline shell, the
cancelable `kora:update-available` window event is dispatched first, so an app that already shows
its own update UI for new service-worker versions shows it here too (its `detail.update()` is
`app.reloadForNewBuild()`). `store.buildPrompt: false` turns every built-in banner off.

`app.reloadForNewBuild()` emits `app:before-build-reload` (forms save their drafts), then reloads.
Under the offline shell it first asks the service worker registration for an update (waiting at
most 10 seconds, then using what is installed), activates
the newer build's waiting worker and reloads once that worker controls the page: a plain reload
could be served the old build by the old worker, and reopening the old build would retire the
genuinely newer tab. So it never reloads while the page is still controlled by the worker that
served its own build: when no newer worker is ready (offline, a failed or slow update check) it
resolves `false`, and the default banner says _"The new version is still downloading in this
browser. Try again in a moment."_ with **Try again**. A custom prompt should do the same.

`BUILD_SUPERSEDED` is a local refusal, retriable after the reload: `useMutation()` reports it in
`error`, never as a server rejection (`rejected`).

### Other states the banner covers

| State | Default message | Event |
|---|---|---|
| This tab is superseded | "A new version of this app is available. Reload to continue." | `app:build-superseded` |
| Its latest changes cannot be saved | "Your latest changes are not saved yet. Retry, or Export them." with **Retry** and **Export** (a JSON download of the database as this tab holds it); "storage is full. Free up space" only when the cause is the quota (`code: 'QUOTA_EXCEEDED'`), "this tab lost its connection to the local database" when it has no storage worker left (`STORAGE_UNAVAILABLE`) | `store:persistence-error` |
| The new tab waits for an older one | "Another tab of this app is still open on an older version. Close it to continue." | `store:build-gate-waiting` (after 10 s, `reason: 'live-writer'`) |
| The older tab needs attention first | "...needs attention: its latest changes are not saved yet." | `store:build-gate-waiting` (`reason: 'unsaved-writes'`) |
| A tab of a build from before the gate is open | "Close other tabs of this app, then reload." | `store:legacy-build-detected` |
| The browser has no `BroadcastChannel` | "This app is open in another tab. Close it to continue here." | `store:tab-exclusive` |

A retiring tab whose save keeps failing **keeps** the database: the new tab waits rather than
open a copy without those changes. Freeing space (then Retry), exporting, or closing that tab
ends the wait; nothing it holds then was confirmed to the user as saved. From the moment a tab
starts retiring, `app.close()` in it first saves every write it accepted, and is refused
(`PersistenceError`, `context.code: 'UNSAVED_WRITES'`) when that fails, instead of handing the
database over without the changes.

A retiring tab that only relayed to another tab of its build (a follower) may find that tab
closed: it has no storage worker left to save from. It first checks the snapshot IndexedDB holds
(the closing tab saved on close, usually with these changes): when they are in it, it retires at
once. Otherwise it shows the "lost its connection" banner and keeps waiting; Retry, Export, or
closing that tab ends it.

### Frozen and background tabs

A tab the browser freezes (or keeps in the back/forward cache) releases the database at once, as
before the gate, so it never blocks the other tabs while it cannot run: same-build tabs take over,
and a newer build can open. On the IndexedDB fallback, changes made in that tab since its last
saved snapshot (the snapshot is saved when the tab is hidden, and every 500 ms) are lost if
another tab takes over; that tab reports them as `SNAPSHOT_SUPERSEDED` when it runs again, and
no write a stored snapshot confirmed is ever lost. A tab frozen while it is still opening or
taking over the database keeps it until it runs again (the new tab waits). A tab that comes back
after a newer build opened never uses the database again: its pending writes fail with
`BuildSupersededError` and it retires.

## Upgrading to beta.15

Builds from before beta.15 do not take part in the gate. After the first gated deployment,
**close all tabs of the app once**: a gated tab detects an old tab that leads the database and
waits for it (`store:legacy-build-detected`), but an old idle follower cannot be detected. From the
next deployment on, every tab speaks the protocol.

## Browsers and test environments

The gate needs Web Locks, which browsers provide only in a **secure context**: HTTPS, or
`localhost`. On plain HTTP (a phone opening `kora dev` at a LAN address, an intranet server
without TLS) there are no Web Locks: the gate is off there, as before it, with one console
warning, and tabs of two deployments are not kept apart. Serve the app over HTTPS (or from
localhost) to turn it on.

Without `BroadcastChannel`, one tab at a time uses the database. A browser without Web Locks on
HTTPS (an outdated one) rejects `app.ready` with `TabCoordinationUnavailableError`
(`TAB_COORDINATION_UNAVAILABLE`); in test environments such as jsdom or happy-dom, set
`store: { allowUncoordinatedTabs: true }`. Node.js, Tauri and other native SQLite apps are not
gated: one process owns the database file.

## Keeping what the user typed: form drafts

A refused write was never applied, and the reload starts the page fresh. To keep what the user was
typing in a form, opt that form into a **draft**. Nothing is drafted unless a form asks for it, and
only the fields it lists:

<!-- docs-check-prelude
import { useFormDraft, useMutation } from 'korajs/react'
-->

```tsx
function NewTodo() {
  const draft = useFormDraft('new-todo', { title: '' }, { fields: ['title'], collection: 'todos' })
  const addTodo = useMutation(async (title: string) => {
    // your write, for example app.todos.insert({ title })
  })
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault()
        await addTodo.mutateAsync(draft.values.title)
        draft.clear() // saved: the draft is no longer needed
      }}
    >
      <input {...draft.bind('title')} />
    </form>
  )
}
```

Vue (`useFormDraft` from `korajs/vue`, `v-model="draft.values.title"` plus
`:ref="draft.fieldRef('title')"`) and Svelte (`useFormDraft` from `korajs/svelte`, a store with a
`use:draft.field={'title'}` action) work the same way.

Drafts live in `sessionStorage` (this tab only) under `kora-draft:<database>:<form key>`, and follow
these rules:

1. **Opt-in, allow-listed.** A field added to the form later is not drafted until you list it.
2. **Sensitive fields are never drafted**, even when listed: password inputs (`type="password"`,
   or `autocomplete` `current-password`, `new-password`, `one-time-code` or `cc-*`; checked on every
   change, and a field once seen as a password stays excluded, so a "show password" toggle does not
   draft it, even one clicked before the first keystroke), inputs marked `data-kora-sensitive`, `t.secret()` fields of `collection`, and fields
   you name in `sensitive: ['ssn', 'diagnosis']`. Sensitivity is per top-level field: a listed
   field holding an object is drafted whole unless you name the nested values, as dotted paths
   (`sensitive: ['answers.ssn']`; in an array of objects, from each element). `allowSensitive`
   overrides this per field or per dotted path (`'answers'` or `'answers.ssn'`); avoid it. An entry that is not one of `fields` has no effect and
   logs a warning.
3. **Password detection needs a resolvable input.** The draft reads the `<input>`, `<textarea>`
   or `<select>` the field is bound to, or the one inside the bound element (component libraries
   whose ref lands on a wrapper are fine). A listed field with no resolvable control (a value set
   from code, a wrapper without a form control) is **not drafted** unless you vouch for it with
   `safe: ['tags']`.
4. **No drafts when the app enables encryption.** A plaintext copy would sidestep it, so nothing is
   stored and the form is simply not restored after the reload.
5. **A restored draft is removed at once.** Call `clearFormDrafts(app)` (from `korajs`) when the
   user signs out or switches accounts; a draft written for another `userId` is removed, never
   restored. With `namespaceByAuthUser`, it clears the drafts of every namespace of the database's
   base name (it errs toward clearing).
6. **Pass the user once the session has loaded.** `userId` is the signed-in user's id, `null` when
   signed out, and `undefined` while the session is still loading: nothing is restored, removed or
   saved until the user is known (`clear()` keeps the stored draft too), then the draft is
   restored, and fields typed meanwhile win over it. Another user (even after a loading state in
   between) resets the form and restores their own draft; one user's input never reaches
   another's. Clear drafts only when a known user changes, never on the first load. A getter
   (`userId: () => ...`) is followed in every binding; Vue also accepts a ref, Svelte a store (or
   `draft.setUser()`).

   <!-- docs-check: skip fragment inside a component (useAuth from @korajs/auth/react) -->
   ```tsx
   const { user, isLoading } = useAuth()
   const draftUser = isLoading ? undefined : (user?.id ?? null)
   const draft = useFormDraft('new-todo', { title: '' }, { fields: ['title'], userId: draftUser })
   ```
7. Use one key per record for edit forms (`edit-todo:${id}`).

Forms that collect sensitive answers should either mark those fields sensitive or not use drafts.

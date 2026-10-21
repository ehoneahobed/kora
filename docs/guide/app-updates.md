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
   syncing (its unsent operations stay queued, and the new build uploads them), gives up the
   database, and releases its lock.
4. Only then does the new tab open storage and run its migrations. There is no timeout: if an older
   tab cannot let go (it is busy, or frozen with unsaved changes), the new tab waits and tells the
   user (`store:build-gate-waiting`).

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
its own update UI for new service-worker versions shows it here too. `store.buildPrompt: false`
turns every built-in banner off.

`BUILD_SUPERSEDED` is a local refusal, retriable after the reload: `useMutation()` reports it in
`error`, never as a server rejection (`rejected`).

### Other states the banner covers

| State | Default message | Event |
|---|---|---|
| This tab is superseded | "A new version of this app is available. Reload to continue." | `app:build-superseded` |
| Its latest changes cannot be saved (storage full) | "Your latest changes are not saved yet (storage is full). Free up space, then Retry." with **Retry** and **Export** (a JSON download of the database as this tab holds it) | `store:persistence-error` |
| The new tab waits for an older one | "Another tab of this app is still open on an older version. Close it to continue." | `store:build-gate-waiting` (after 10 s, `reason: 'live-writer'`) |
| The older tab needs attention first | "...needs attention: its latest changes are not saved yet." | `store:build-gate-waiting` (`reason: 'unsaved-writes'`) |
| A tab of a build from before the gate is open | "Close other tabs of this app, then reload." | `store:legacy-build-detected` |
| The browser has no `BroadcastChannel` | "This app is open in another tab. Close it to continue here." | `store:tab-exclusive` |

A retiring tab whose save keeps failing **keeps** the database: the new tab waits rather than
open a copy without those changes. Freeing space (then Retry), exporting, or closing that tab
ends the wait; nothing it holds then was confirmed to the user as saved.

## Upgrading to beta.15

Builds from before beta.15 do not take part in the gate. After the first gated deployment,
**close all tabs of the app once**: a gated tab detects an old tab that leads the database and
waits for it (`store:legacy-build-detected`), but an old idle follower cannot be detected. From the
next deployment on, every tab speaks the protocol.

## Browsers and test environments

The gate needs Web Locks (every browser Kora supports has them). Without `BroadcastChannel`, one
tab at a time uses the database. Without Web Locks, `app.ready` rejects with
`TabCoordinationUnavailableError` (`TAB_COORDINATION_UNAVAILABLE`); in test environments such as
jsdom or happy-dom, set `store: { allowUncoordinatedTabs: true }`. Node.js, Tauri and other native
SQLite apps are not gated: one process owns the database file.

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
five rules:

1. **Opt-in, allow-listed.** A field added to the form later is not drafted until you list it.
2. **Sensitive fields are never drafted**, even when listed: inputs with `type="password"` (checked
   on every change), inputs marked `data-kora-sensitive`, `t.secret()` fields of `collection`, and
   fields you name in `sensitive: ['ssn', 'diagnosis']`. `allowSensitive` overrides this per field;
   avoid it.
3. **No drafts when the app enables encryption.** A plaintext copy would sidestep it, so nothing is
   stored and the form is simply not restored after the reload.
4. **A restored draft is removed at once.** Call `clearFormDrafts(dbName)` (from `korajs`) when the
   user signs out or switches accounts; a draft written for another `userId` is never restored.
5. Use one key per record for edit forms (`edit-todo:${id}`).

Forms that collect sensitive answers should either mark those fields sensitive or not use drafts.

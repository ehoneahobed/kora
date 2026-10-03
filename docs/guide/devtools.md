---
title: DevTools
description: "Inspect operations, trace merge conflicts, and monitor sync in real time with Kora DevTools: the browser extension and in-page overlay."
---

# DevTools

Kora DevTools shows what happens to your data as it happens: operations, merge decisions, sync
traffic and connection state. It is a Chromium DevTools extension plus an in-page overlay, both fed
by the same instrumentation events.

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
const schema = defineSchema({ version: 1, collections: { todos: { fields: { title: t.string() } } } })
const app = createApp({ schema })
-->

## Enabling DevTools

Every `create-kora-app` template enables it in development builds. In an existing app:

```typescript
const devApp = createApp({
  schema,
  devtools: import.meta.env.DEV,
})
```

With `devtools: true`, `createApp` records events in a ring buffer (10 000 events), forwards them
to the extension with `window.postMessage`, and mounts the overlay. Leave it off in production: the
instrumentation runs only when enabled.

## The in-page overlay

Press **Ctrl+Shift+K** (Cmd+Shift+K on macOS) in the running app to toggle the overlay. It needs no
extension and shows the same panels.

## The browser extension

The extension is not published to a store yet. Build and load it from the monorepo:

```bash
pnpm --filter @korajs/devtools build
# chrome://extensions -> Developer mode -> Load unpacked -> packages/devtools/dist/extension
```

Then open Chrome DevTools (F12) on the app and select the **Kora** tab. It works in Chromium-based
browsers (Chrome, Edge, Brave).

## Panels

A toolbar switches panels, filters by text and toggles event categories (operation, merge, sync,
query, connection). Click a row to expand it.

| Panel | Shows |
|-------|-------|
| **Timeline** | Recorded events in order, color-coded by type; operations list the operations they depend on. |
| **Conflicts** | Every merge conflict: time, collection, field, strategy, tier and result; expanding a row shows both inputs, the output and any violated constraint. |
| **Operations** | Operations created on this device and applied from sync since DevTools started: id, type, collection, record, data, node, sequence number and causal dependencies. |
| **Network** | Connection state and quality, operations sent and received, an estimate of unacknowledged uploads, the last sync time, a version vector derived from the recorded operations, and recent sync activity. |

The panels show what was recorded since the page loaded (up to the buffer size), not the whole
local database. For authoritative numbers use `app.sync.getStatus()` (for example
`pendingOperations`) and `app.sync.exportDiagnostics()`. The toolbar's Pause and Clear buttons
currently only change the button label and collapse expanded rows; they do not stop or clear the
recording.

`kora studio` (see the [CLI](/api/cli)) offers a separate view of the same events for a running
app.

## Debugging common issues

**Why did this field change?** In **Operations**, filter by the record id and find the newest
operation that wrote the field; its `nodeId` says which device wrote it. In **Conflicts**, the
trace shows which strategy picked the value.

**Why did this conflict resolve this way?** Expand the conflict: the strategy names the rule from
[Conflict Resolution](/guide/conflict-resolution) (`lww`, `lww-element-set`, `object-key-lww`,
`crdt-text`, `schema-counter`, `custom`, ...). Tier 3 is a custom resolver.

**Why is data not syncing?** Check **Network** for the connection state, then
`app.sync.getStatus()`: `status`, `phase`, `reason` (for example `auth-required` or
`encryption-locked`), `pendingOperations`, and `blockedFailure` when a received operation cannot be
applied. Refused uploads are in `app.sync.getRejectedOperations()`.

**Why is the first sync slow?** Narrow what each client receives with server-side scopes (see
[Authentication](/guide/authentication#sync-scopes)) or query views (see
[Sync Configuration](/guide/sync-configuration#query-views)).

## Listening to events in code

Every event DevTools shows is available on the app:

```typescript
app.events.on('operation:created', (event) => {
  console.log('New operation:', event.operation.id)
})

app.events.on('merge:conflict', (event) => {
  console.log('Conflict on', event.trace.field, 'resolved by', event.trace.strategy)
})

app.events.on('sync:operation-rejected', (event) => {
  console.warn('Server refused', event.operationId, event.code)
})
```

The complete catalog, with payloads and which events DevTools records, is in the
[DevTools API reference](/api/devtools#events).

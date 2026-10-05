---
title: Multi-runtime Storage
description: "Run multiple Kora runtimes on one origin safely: store names, multi-tab leader/follower coordination, per-database OPFS pools, and the storage diagnostics."
---

# Multi-runtime storage and isolation

A Kora store persists to a database identified by a name. In the browser that
name maps to its own OPFS storage pool (SyncAccessHandle pool) or an IndexedDB key; on
the server and in Node it maps to a SQLite file. The name defaults to `kora-db`:

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
const schema = defineSchema({ version: 1, collections: { notes: { fields: { body: t.string() } } } })
const publicSchema = schema
-->

```typescript
const app = createApp({
  schema,
  store: { name: 'my-app' }, // OPFS pool / IndexedDB key / SQLite file name
})
```

Most apps never think about this. It matters the moment more than one runtime runs
on the same origin, because OPFS persistence is single-writer: only one runtime at
a time can hold the access handles for a given database.

## Multiple tabs of the same app

Two tabs of the same app that share a database name are the normal case, and Kora
handles it for you. The tabs elect a leader through `navigator.locks`; the leader
owns the single SQLite worker and the database's OPFS pool (held under its own Web Lock), and
follower tabs proxy their reads and writes to the leader over a `BroadcastChannel`. You do not
configure anything. All tabs see one consistent database, and a hung or closed leader is replaced
by a follower.

Live queries stay current in every tab. Each committed change to a collection's rows is
announced to the other tabs on the same database: local writes, operations sync applied in
the syncing tab, and changes made without a new operation (a write the server refused being
undone, records leaving the user's sync scope, cascades settling, a re-materialization, a
backup restore). The other tabs re-run their affected queries; they never reapply anything.

When a tab attaches as a follower, Kora emits a `store:db-name-collision`
diagnostic. For multi-tab of one app this is expected and informational.

## Multiple logically separate apps on one origin

The trap is two *different* apps on the same origin that both use the default name.
If a workspace app and an embedded respondent widget both open `kora-db`, the
second does not get its own database: it attaches to the first as a follower and shares its
data (reported with `store:db-name-collision`). That is not what you want.

The fix is one line: give each logically separate runtime a distinct store name.

```typescript
const workspace = createApp({ schema, store: { name: 'acme-workspace' } })
const respondent = createApp({ schema: publicSchema, store: { name: 'acme-respondent' } })
```

Distinct names give each runtime its own OPFS pool and its own leader lock, so
they persist independently and never contend. This is deliberately left to you
rather than inferred: only you know whether two runtimes are the same app across
tabs (share the name) or separate apps that must stay isolated (distinct names).

## Diagnostics instead of silent failure

Kora never trades durability away quietly:

- When OPFS cannot be used, the store falls back to durable IndexedDB (`store:storage-fallback`).
- When another holder still has the database's pool (a tab shutting down, or a tab running an
  older Kora), the open **waits** and reports it (`store:storage-blocked`, `waiting` then
  `resolved`) instead of falling back.
- Only when no durable storage can be obtained at all does the store run in memory, and then it
  emits the blocking `store:durability-lost` (plus `store:opfs-unavailable`) and refuses writes
  with `StorageDurabilityError`, unless the app opted in with `store.allowNonDurable`.

<!-- docs-check: continue -->
```typescript
const app = createApp({ schema })

app.on('store:durability-lost', (event) => {
  // event.reason: 'lock-conflict' | 'timeout' | 'unsupported' | 'open-failed'
  console.error(`Storage is not durable (${event.reason}): ${event.message}`)
})

app.on('store:storage-blocked', (event) => {
  if (event.state === 'waiting') console.warn('Close other tabs of this app to continue.')
})

app.on('store:db-name-collision', (event) => {
  // Another runtime on this origin already owns event.dbName. Expected for tabs of
  // the same app; a bug if these are separate apps that should each have a name.
  console.info(event.message)
})
```

Both events also appear in Kora DevTools, so you can see them during development
without wiring a listener.

## Naming conventions

Prefer a stable, human-readable name per logical app, namespaced if you ship more
than one on an origin: `acme-workspace`, `acme-respondent`, `acme-admin`. Avoid
deriving the name from volatile values (a user id, a random id) unless you truly
want a fresh, separate database each time, since a changed name is a different
database with none of the previous data.

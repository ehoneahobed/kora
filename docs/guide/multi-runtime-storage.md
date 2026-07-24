---
title: Multi-runtime Storage
description: "Run multiple Kora runtimes on one origin safely: store names, multi-tab leader/follower coordination, the OPFS single-writer model, and the store:opfs-unavailable and store:db-name-collision diagnostics."
---

# Multi-runtime storage and isolation

A Kora store persists to a database identified by a name. In the browser that
name maps to an OPFS file (via the SyncAccessHandle pool) or an IndexedDB key; on
the server and in Node it maps to a SQLite file. The name defaults to `kora-db`:

```typescript
const app = createApp({
  schema,
  store: { name: 'my-app' }, // OPFS file / IndexedDB key / SQLite file name
})
```

Most apps never think about this. It matters the moment more than one runtime runs
on the same origin, because OPFS persistence is single-writer: only one runtime at
a time can hold the access handles for a given database.

## Multiple tabs of the same app

Two tabs of the same app that share a database name are the normal case, and Kora
handles it for you. The tabs elect a leader through `navigator.locks`; the leader
owns the single SQLite worker and the OPFS handles, and follower tabs proxy their
reads and writes to the leader over a `BroadcastChannel`. You do not configure
anything. All tabs see one consistent database.

When a tab attaches as a follower, Kora emits a `store:db-name-collision`
diagnostic. For multi-tab of one app this is expected and informational.

## Multiple logically separate apps on one origin

The trap is two *different* apps on the same origin that both use the default name.
If a workspace app and an embedded respondent widget both open `kora-db`, the
second does not get its own database. It either attaches to the first as a
follower and silently shares its data, or, if it forces its own worker, collides
on the OPFS pool and cannot persist. Neither is what you want.

The fix is one line: give each logically separate runtime a distinct store name.

```typescript
const workspace = createApp({ schema, store: { name: 'acme-workspace' } })
const respondent = createApp({ schema: publicSchema, store: { name: 'acme-respondent' } })
```

Distinct names give each runtime its own OPFS file and its own leader lock, so
they persist independently and never contend. This is deliberately left to you
rather than inferred: only you know whether two runtimes are the same app across
tabs (share the name) or separate apps that must stay isolated (distinct names).

## Diagnostics instead of silent failure

When OPFS persistence is unavailable, the store falls back to a non-persistent
in-memory database so the app keeps working, but anything written that session is
lost on reload. That fallback used to be silent. It is now observable: Kora emits
`store:opfs-unavailable` with a reason so you can detect and surface it rather than
losing data quietly.

```typescript
app.events.on('store:opfs-unavailable', (event) => {
  // event.reason: 'lock-conflict' | 'timeout' | 'unsupported'
  // 'lock-conflict' means another runtime on this origin holds this database;
  // the usual cause is two apps sharing one store name (see above).
  console.warn(`Storage is not persistent (${event.reason}); data will not survive a reload.`)
})

app.events.on('store:db-name-collision', (event) => {
  // Another runtime on this origin already owns event.dbName. Expected for tabs of
  // the same app; a bug if these are separate apps that should each have a name.
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

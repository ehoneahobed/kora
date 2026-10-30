---
title: Instant Updates
description: "Show a write in live queries before its storage transaction commits: the instantUpdates option, what a shown row does and does not mean, the per-write durable option, rollbacks, limits and DevTools events."
---

# Instant Updates

By default a write appears in your live queries (`useQuery`, `subscribe`) after its storage transaction has committed. In a browser that means a round trip to the SQLite worker, so a typed character or a toggled checkbox can take a few frames to show. **Instant updates** show the write in this tab's live queries at once, in the same frame, and let the database confirm it a moment later.

It is **off by default** in `1.0.0-beta.15`. Turn it on per app:

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
const schema = defineSchema({ version: 1, collections: { todos: { fields: { title: t.string(), completed: t.boolean().default(false) } } } })
const app = createApp({ schema })
declare const todoId: string
declare const draftId: string
declare function showSavingBadge(): void
-->

```typescript
const instantApp = createApp({
  schema,
  store: { instantUpdates: true },
})
```

Nothing else changes in your code. `insert`, `insertMany`, `update` and `delete` keep their signatures and their promises resolve at the same point as before.

## What a shown row means

The write itself is not changed: same operation, same id, same order, stored the same way. What is new is a short-lived, tab-local **prediction**:

1. You call `app.todos.update(id, { completed: true })`.
2. Kora computes the record the write will produce and patches this tab's live query results with it, in memory.
3. The storage transaction commits. Kora re-runs the query against SQLite and the database result replaces the prediction. The database is always right: a prediction never survives a SQL result that disagrees with it.

Two consequences matter to your UI.

**A shown row is not saved.** Only the write's promise resolving means the write is committed. Until then, closing the tab, a crash or a worker restart loses it, exactly as it would have before the row was visible. If your app shows save state, drive it from the promise, not from the presence of the row. Keep a count of writes whose promise has not resolved and warn on unload while it is above zero:

```typescript
let unsaved = 0

async function save(write: Promise<unknown>): Promise<void> {
  unsaved++
  try {
    await write
  } finally {
    unsaved--
  }
}

addEventListener('beforeunload', (event) => {
  if (unsaved > 0) event.preventDefault()
})

void save(app.todos.update(todoId, { completed: true }))
```

**A row can disappear.** If the transaction fails (a restrict constraint, a record deleted remotely, a quota error), the prediction is removed and the row leaves the query results. The write's promise rejects with the error, so handle it:

```typescript
async function toggle(): Promise<void> {
  try {
    await app.todos.update(todoId, { completed: true })
  } catch (error) {
    showSavingBadge()
    throw error
  }
}
```

With `useMutation`, read `error` from the hook. A `mutate` call with no error handling makes a row vanish silently when it fails.

## Waiting for the commit on one write: `durable: true`

Pass `{ durable: true }` as the last argument of a write to skip the prediction for that write only. The write appears when it has committed, exactly as with instant updates off.

```typescript
await app.todos.insert({ title: 'Pay invoice' }, { durable: true })
await app.todos.update(todoId, { completed: true }, { durable: true })
await app.todos.delete(todoId, { durable: true })
```

The name means "wait for the commit before showing", not "more durable": the write is stored the same way either way and its promise resolves at the same point. Use it where a vanishing row would be worse than a short delay, for example a payment record.

## What is shown early

Kora shows only writes it can predict exactly:

- inserts, updates and deletes of one record, and `insertMany` up to the record limit;
- `app.transaction` and `app.mutation`, as one unit (see below), up to the record limit;
- on queries it can evaluate in memory: filters on stored fields, `orderBy`, `limit`, no `include`;
- on collections whose fields use the default last-write-wins merge, with no richtext, secret, auto-computed or custom-resolver fields involved.

Everything else (a write with a custom resolver, a cascading delete, a query with `include`) runs exactly as it does with the feature off: it appears at commit. This is silent and safe. `store:write-pending` reports `predicted: false` with the reason, so you can see in DevTools why a write was not shown early.

## Transactions and mutations

A transaction is shown as one unit: all of its writes appear together, in the same frame, once its callback has returned, and they commit or disappear together.

```typescript
await app.mutation('archive-and-replace', async (tx) => {
  const next = await tx.todos.insert({ title: 'Follow-up' })
  await tx.todos.update(todoId, { completed: true, title: `Done, see ${next.id}` })
  await tx.todos.delete(draftId)
})
```

- Nothing is shown while the callback runs. Reads inside it (`tx.todos.findById`) see the transaction's own writes, as before, and never another write's prediction.
- If one write of the transaction cannot be predicted (an atomic op such as `op.increment`, a cascading delete, a field with a merge strategy), none of it is shown early: the whole transaction appears at its commit. A transaction never appears half shown.
- If the commit fails, every write of the transaction leaves the lists at once, and so does any later write that was built on one of them.
- A list shows all of a transaction's changes to its rows or none of them. Two different lists can still differ for a moment (one may have to wait for the commit, for example a full page from which a row would leave); the commit brings both up to date.
- `store:write-pending` and `store:write-settled` are emitted once per transaction, with `kind: 'transaction'` and `collections` listing every collection it touched.
- The records a transaction updates or deletes need their current values. Kora uses the row the callback already read for its `update` or `delete` (or a row a list has shown). Only if something changed that collection after the callback's read does it read the row again, and a read that does not answer within a few milliseconds makes the transaction wait for its commit instead.
- Inserts of one transaction get the same predicted `createdAt`. Order a list by `createdAt` and then `id` if it should show a transaction's new rows before the commit.

Limits keep the in-memory state small. Beyond them a write simply waits for its commit:

```typescript
const limited = createApp({
  schema,
  store: {
    instantUpdates: {
      maxPendingWrites: 256, // writes shown but not yet committed, per tab
      maxPendingBytes: 8 * 1024 * 1024,
      maxRecordsPerWrite: 100,
    },
  },
})
```

## Safety nets

- **Self-check.** Every time a database result replaces a prediction, Kora compares the two. A difference on any field other than `createdAt` and `updatedAt` emits `store:overlay-diverged` (field names only). Three divergences in one collection stop prediction for it for the rest of the session (`store:overlay-disabled`); its writes then behave as with the feature off.
- **Test builds fail loudly.** With `NODE_ENV=test` a divergence throws an `OverlayDivergedError` so a wrong prediction cannot hide in your test suite.
- **Unknown outcomes.** If the connection to the storage worker is lost during a commit, Kora looks the write up by its content-addressed operation id. If it landed, the prediction becomes the stored row; if not, it is rolled back. A write that cannot be decided stays shown until the lookup can run, and never longer than a minute.
- **Cleared with the data.** Closing the store, switching or signing out the user, reloading from disk, restoring a backup and a full resync all drop every prediction before the queries re-run.
- **Tab-local.** Predictions are never stored, synced or sent to other tabs. Another tab sees the write when it commits, as before.

## Events

| Event | When |
|-------|------|
| `store:write-pending` | a write was registered (`predicted: true`), or not shown early (`predicted: false`, with `reason`); one event per transaction (`kind: 'transaction'`, `collections`) |
| `store:write-settled` | the write committed, rolled back or has an unknown outcome, with how long it was shown (`pendingMs`); one event per transaction |
| `query:patched` | a subscription delivered rows built from a prediction |
| `store:overlay-diverged` | a prediction differed from the database |
| `store:overlay-disabled` | the circuit breaker stopped prediction for a collection |

DevTools lists them in the operation and query timelines. `store:write-settled` with `committed` does not mean "saved": the write's promise is the only saved signal.

## IndexedDB fallback

The IndexedDB fallback store uses the same setting. Its commits take longer (the database is also persisted to IndexedDB), so the early view is more noticeable there.

## Turning it off

Remove the option, or set `instantUpdates: false`. With it off, no overlay code runs and behavior is identical to earlier releases.

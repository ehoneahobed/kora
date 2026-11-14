---
"@korajs/store": minor
"korajs": minor
---

`app.setReadOnly(reason)` makes an app instance read-only: every local write (insert, insertMany, update, delete, `app.mutation`, `app.transaction`, and writes queued before `app.ready`) throws the new `StoreReadOnlyError` (`STORE_READ_ONLY`, carrying the reason) before anything is recorded, also when the write would be relayed to another tab. Reads, subscriptions and incoming sync are unaffected. `app.setReadOnly(null)` makes it writable again; `app.readOnlyReason()` reports the state. On the store: `store.setReadOnly()`, `store.getReadOnlyReason()` and `store.assertWritable()`. Found building an admin "view as" preview in KoraPOS, which must save nothing whatever screen the admin opens.

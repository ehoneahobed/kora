---
"@korajs/store": minor
"korajs": minor
---

Faster local writes in the browser, and `collection.insertMany(rows)`.

- **Batched worker messages.** Inside a write's transaction the store now buffers its write statements and sends them to the SQLite worker in batches (a new `batch` worker request, run with cached prepared statements), instead of one message per statement. Reads inside the write first send what is buffered, and everything is sent before the commit, so a write that resolved is committed exactly as before and a failing statement still rolls the whole write back. Inserting 10,000 records in one transaction on OPFS went from about 6.2 s to 1.8 s in Chromium. A worker from an older build (another tab still on the previous deploy as storage leader) is sent statements one by one, as before.
- **16 KiB pages for new OPFS databases** (SQLite's default is 4 KiB): the commit of a large write is about 40% cheaper, a one-row commit costs the same. Existing databases keep their page size.
- **`app.<collection>.insertMany(rows)`** (also on `store.collection(name)` and `useCollection`): inserts many records of one collection in one transaction, all or none. Every row is validated before anything is written; each record is still its own insert operation (input order, consecutive sequence numbers, one shared `transactionId`), and live queries update once after the commit. 10,000 records take about 1.7 s on OPFS. Inside `app.transaction`, `tx.<collection>.insertMany(rows)` adds the rows to that transaction.
- `Transaction` gains an optional `executeBatch(statements)`; `LocalMutationHandler` an optional `insertMany`. Custom adapters and handlers need no change. `LocalMutationHandler.beforeLocalDelete` still gets a transaction whose `await tx.execute(...)` means the statement ran (it is not buffered).

Awaited single `insert` calls are unchanged: each is still its own durable transaction (about 34 ms each on OPFS in that benchmark, almost all of it SQLite and OPFS commit time). Use `insertMany` or `app.transaction` for bulk writes.

---
'@korajs/server': patch
---

The memory, SQLite and Postgres server stores now answer the same query the same way. This covers route queries, scoped route queries, constraint lookups and `countCollection`.

- **Boolean filters:** `where { done: true }` works on SQLite and Postgres. It used to throw on SQLite.
- **Null filters:** `where { field: null }` matches null or absent fields. It used to match nothing.
- **Null ordering:** `orderBy` puts nulls last in both directions on every store.
- **String ordering:** strings compare by code point, so Postgres no longer uses its database locale for this.
- **Ties:** `id` breaks ties and is the default order, so paging with `limit` and `offset` is stable.
- **Offset without limit:** SQLite now accepts `offset` without `limit`.

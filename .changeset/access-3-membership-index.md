---
"@korajs/server": minor
---

Server stores keep a membership index for access rules: one interval per membership, opened and closed at the delivery sequence of the operation that changed it, inside that operation's write transaction (memory, SQLite and Postgres, including Postgres conditional applies). Memberships come from the schema's memberships collection and from the owners of group records (`access.groups`), who are members for as long as they own the record. An index built from existing records (the first access schema, a new group collection, a replace-mode backup restore) counts every membership as held from the start. `getMembershipIntervals(userId)` reads it. Access rules are still not enforced by the sync server.

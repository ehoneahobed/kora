---
"@korajs/server": patch
---

A deleted group grants its members nothing: deleting a record of a group collection ends every membership of it at that operation (their devices are re-scoped, their writes refused), the owner keeps it, and a write that revives the record restores the memberships. Previously members kept access to the children of a deleted group until the app revoked them.

---
'@korajs/server': patch
---

Relay presence per record (F16). An awareness state whose cursor names a record now reaches every
session whose download scope contains that record, the rule the Yjs doc channel already used, so
collaborators with different grants see each other's carets on the documents they share. A cursor
on a record the sender cannot read, or a malformed cursor, reaches nobody. A state without a cursor
stays within sessions holding the identical download scope and never reaches or leaves anonymous
sessions. A session shown an earlier state that it may no longer see receives a removal.
`AwarenessRelay.handleUpdate` takes an optional audience callback. When the record a
cursor names changes on the server (an upload, a server-authored write, or a write through another
instance), the audience is decided again (`AwarenessRelay.updateAudience`): sessions that may no
longer read the record get a removal and later catch-ups skip it.

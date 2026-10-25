---
'@korajs/server': patch
---

The outbound payload gate decides whether an update's base (`previousData`) may be cut from the operation as the schema reads it: fields renamed by a schema transform are classified through the transformed view, and a field the schema does not know counts as base-reading (the update is withheld, not cut). The operation's wire form is unchanged.

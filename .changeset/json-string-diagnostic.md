---
'@korajs/server': patch
---

New `findJsonStringValues(store)` diagnostic (F14): after an upgrade from a server older than
beta.13, it lists the `t.json()` / `t.object()` fields whose rows hold JSON-encoded strings (which
old servers decoded one layer of when building rows), with counts and sample ids. Values are not
rewritten automatically, since a string is also a valid json value.
It refuses a `pageSize` that is not a positive integer (`InvalidDiagnosticOptionsError`), which
would otherwise loop forever.

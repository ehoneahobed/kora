---
"@korajs/store": minor
"@korajs/sync": minor
"korajs": minor
"@korajs/core": patch
---

Access rules on the device. An insert fills fields declared `t.string().stamp('userId')` with the signed-in user (the app knows it through `authClient` or a `principal`), so apps no longer pass `ownerId` themselves; naming another user, or inserting before the app knows who is signed in without passing the field, throws `StampedFieldError` (`STAMP_MISMATCH`, `STAMP_USER_UNKNOWN`). A group created offline, with content in it, syncs without ever leaving the device. A scope retraction of an access-collection record that has unsent writes is deferred, durably, until those writes are acknowledged or refused, so offline work is judged by the server instead of quarantined; the record is hidden then and `sync:scope-retracted` is emitted.

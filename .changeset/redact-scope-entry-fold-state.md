---
'@korajs/core': patch
'@korajs/server': patch
---

A scope entry no longer shows a new member what a record held before they could read it. Removed array elements and deleted object keys keep their merge stamps under a salted digest, without the value, so a late write still merges exactly as before, and a max/min field's shadowed value and richtext updates hidden by a reset are no longer sent. Richtext sends only the updates no newer one contains, with deleted text removed, which also makes these entries far smaller. Counters, atomic chains and custom-resolver logs are still sent because merging needs them, as is richtext one device deleted while another saved a later edit without having seen the deletion; the access-rules guide says what to do about that.

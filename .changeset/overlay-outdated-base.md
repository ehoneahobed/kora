---
'@korajs/store': patch
---

Instant updates no longer briefly show an earlier value of a field the app had just changed. When a sync or another tab changed a record while one of the app's own writes to it was still pending, the next write was predicted from a cached row older than that pending write, so until it committed the screen showed the record without the pending change. That write now reads the record instead, as intended. Found by the overlay property test.

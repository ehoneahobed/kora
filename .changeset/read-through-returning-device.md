---
'korajs': patch
---

A device whose replica has completed no longer reads through. Seeding skips records with local history, so a server answer shown first was replaced by the older local row until delivery caught up, and the page went fresh, stale, fresh. Such a device now opens its store at once and catches up from the stream. A device whose first download never finished keeps reading through.

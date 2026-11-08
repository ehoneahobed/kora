---
"@korajs/server": patch
---

Fix a first download that took minutes when the database is in another region. Editing a group record you already own (a form, a board) is no longer treated as a membership change, so a fresh device no longer waits for a grant refresh and a rebuilt scope unit per edit; and an access session now reads the records of a delivery chunk in one batched query per collection instead of one read per operation. A form edited hundreds of times used to cost about 25 sequential statements per edit, about 1.6 seconds each at 65 ms between the server and its database.

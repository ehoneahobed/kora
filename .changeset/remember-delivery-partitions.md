---
"@korajs/server": patch
---

The SQLite and Postgres server stores remember the delivery partitions (`deliveryPartitions`) they were last given. A store applies its schema before the sync server hands over the partitions, and a script opens it with `setSchema(schema)` alone. Before, either one derived a plan without the partitions, so every restart dropped the delivery index and rebuilt it (twice for a server), and sessions read through the slower global scan meanwhile. Partitions that really change still rebuild the index once.

---
"@korajs/server": minor
---

Delivery visibility index (C2, first part). The server derives, for every collection, the fields an operation is filed under (`P(c)`): the scope and `sync` bindings, every field an access read rule names (recursively through `or` and `and`), the memberships collection's `userId` and `group`, and each group collection's `id` and owner field. A new `KoraSyncServer` option `deliveryPartitions: { [collection]: string[] }` adds fields for providers whose scopes the schema cannot show (a `TokenAuthProvider` scope is an arbitrary map). The plan's fingerprint is stored in `kora_server_meta` (`delivery_partition_fields`); the stores gain `setDeliveryPartitions` and `getDeliveryPartitionState`. The index only narrows what is read and never decides delivery: the session's filter stays the single authority.

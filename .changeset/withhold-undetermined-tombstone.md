---
'@korajs/server': patch
'@korajs/core': patch
---

Access rules: when the server cannot determine where a record's deletion began, a stale write onto that record is now **withheld** from the member instead of sent once the 15-second hold expires (#78). This also applies past the 1,024-hold cap and on streams that cannot be held. The gate never sends what it cannot prove the member may receive, so a member who joined after the delete is never shown it.

The member's device keeps the record deleted. The server remembers the record for that device (`markDeliveryWithheld` / `getDeliveryWithheld` / `clearDeliveryWithheld` on the server stores, kept in `kora_server_meta`, shared by every instance and surviving reconnects). If the record is revived, the device first receives the record's current state and converges.

`server:tombstone-delivery-undetermined` now reports `action: 'withheld'` instead of `'sent'`, and the server metrics gain `withheldDeliveries`.

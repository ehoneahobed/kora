---
"@korajs/store": patch
---

`ContentAddressedBlobStore.durable` is optional. It was added as a required member with kept files (A5), which stopped custom blob stores from compiling. A store that does not declare it is treated as not durable (`storage-non-durable` for a pin that keeps files); declare `readonly durable = true` on a store whose bytes survive a restart.

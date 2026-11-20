---
"@korajs/cli": patch
---

`kora deploy --platform aws-lightsail` forwards the settings `createProductionServer` and the blob store read from the environment: `KORA_INSIGHTS_TOKEN`, `KORA_ALLOWED_ORIGINS`, `KORA_BLOB_STORE_URL` (with its access key, secret, region and endpoint) and `KORA_BLOB_DIR`. They were dropped before, so on Lightsail files stayed on the container's disk instead of the configured store. A test now checks the list against every `KORA_*` setting the server reads.

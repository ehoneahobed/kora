---
"@korajs/cli": patch
---

Add `kora export` and `kora import --platform kora-cloud`. `kora export` bundles an app's whole PostgreSQL database (through `pg_dump`) and the files in `KORA_BLOB_DIR` into one `.tar`, in the format Kora Cloud's backup downloads use; nothing in the app is changed. `kora import` uploads such a bundle straight to a Kora Cloud project's own backup storage, where it is verified like a backup and can then be loaded into production or opened as a recovery environment.

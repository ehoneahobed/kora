---
"@korajs/cli": patch
---

`kora import <bundle>` without `--platform` loads a bundle (`kora export`, or a backup downloaded from Kora Cloud) into your own PostgreSQL database and files folder (`--database-url`/`DATABASE_URL`, `--blob-dir`/`KORA_BLOB_DIR`). It checks the whole bundle first (the dump's checksum, every file against its name), refuses a database that already holds tables, restores in one transaction, compares row counts with the bundle's, and copies files last. The backup guide shows the whole restore with Docker Compose.

---
"@korajs/server": minor
"@korajs/store": minor
"@korajs/core": minor
"@korajs/test": minor
"@korajs/auth": patch
"@korajs/cli": minor
---

Things apps had to work out for themselves now work out of the box, found by running Kora apps on Kora Cloud:

- **File storage without code.** `createProductionServer` keeps the bytes behind `t.blob()` fields where the host says (`KORA_BLOB_STORE_URL`, or `KORA_BLOB_DIR`), and sweeps unused bytes daily. Set `blobStore` to choose a store in code, or `false` to keep none. An app that wires blob callbacks itself is unchanged.
- **Unused-file sweeps never take a new upload.** `collectBlobGarbage` keeps unreferenced blobs written within the last day (`graceMs`), because a device uploads a blob before the record that points at it. This applies to stores that know write times: `FilesystemBlobStore` now does, and a re-upload refreshes it. `@korajs/store/blob-object` exports the server-side helpers (`toServerBlobCallbacks`, `collectBlobGarbage`).
- **Settings declared in `.env.example`.** Tags in comments mark what production needs (`[required]`), credentials (`[secret]`) and local-only settings (`[development]`). `parseEnvExample` and `missingRequiredEnv` in `@korajs/core` read them, `kora doctor` reports them (`--production` fails on a missing required one), and templates ship a tagged file with the file-store settings.
- **Testing access rules across users.** `new TestServer(schema, { auth: true })` and `new TestDevice({ user: 'alice', ... })` sign devices in, so access rules apply as in production, without assembling devices from internals.
- **Quieter logs.** The Postgres auth stores no longer print "already exists, skipping" notices on every start.
- **Generated `AGENTS.md`** covers file storage, settings, multi-user tests and deploying.

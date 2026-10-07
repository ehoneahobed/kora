---
title: Backup and Restore
description: "Back up and restore Kora.js sync server data: backup commands, storage format, scheduling, and recovery workflows for offline-first apps."
---

# Backup and Restore

Kora supports two backup paths:

- **Local app backups** for a client database, using `app.exportBackup()` and `app.importBackup()`.
- **Sync server backups** for all synced operations on the server, using the `kora backup` CLI.

Use local app backups for user-controlled export/import, desktop app data portability, or support workflows. Use sync server backups for production operations, disaster recovery, and environment migration.

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
const app = createApp({
  schema: defineSchema({
    version: 1,
    collections: { projects: { fields: { name: t.string() } }, todos: { fields: { title: t.string() } } },
  }),
})
declare const oldBackup: Uint8Array
-->

## Local App Backups

Every Kora app exposes backup methods after `app.ready` resolves:

```typescript
await app.ready

const backup = await app.exportBackup()
```

`backup` is a `Uint8Array` (format version 2) containing the operation log and metadata needed to restore the local store.

### Download a Backup in the Browser

```typescript
async function downloadBackup() {
  await app.ready
  const data = await app.exportBackup()
  const blob = new Blob([new Uint8Array(data)], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)

  const link = document.createElement('a')
  link.href = url
  link.download = `kora-backup-${Date.now()}.kora`
  link.click()

  URL.revokeObjectURL(url)
}
```

### Restore a Local Backup

```typescript
async function restoreBackup(file: File) {
  await app.ready
  const data = new Uint8Array(await file.arrayBuffer())

  const result = await app.importBackup(data, {
    merge: true,
    onProgress(progress) {
      console.log(progress.phase, progress.progress)
    },
  })

  console.log(`Restored ${result.operationsRestored} operations`)
}
```

Use `merge: true` when you want to import without deleting existing local data. Use `merge: false` (the default) when you want the backup to replace the local store.

A restore never copies the exporting device's identity. A backup holds the operation log
(every operation in canonical form, deletions included), the materialized rows (deleted
rows included), the version vector and the operations the sync server refused for good. It
does not hold the device's node id, sync credentials or sync progress, so restoring a backup
made on another device does not turn this device into a clone of it.

- **Merge** (`merge: true`) applies every operation of the backup exactly like an
  operation received from sync: duplicates are skipped by id, concurrent edits merge per
  field, and the version vector only moves forward. Sync keeps running.
- **Replace** (default) replaces the local data with the backup's. This device keeps its
  node id, its sync credentials and the users its writes belong to, and its own sequence
  numbers never move backwards. Sync is paused during the restore and resumes afterwards,
  re-downloading everything in scope from the server. Live queries re-run with the restored
  data.
  - With sync configured, writes made on this device that the sync server has not
    acknowledged are kept: they are applied again on top of the backup, so a restore never
    discards writes that exist nowhere else (`result.unsyncedWritesKept` counts them).
  - In a local-only app (no `sync`), replace is exact by default. Pass
    `keepUnsyncedWrites: true` to keep the writes made since the backup was taken.

A backup also carries the device's **compacted history**. Compaction folds operations
the server acknowledged into per-record base states and removes them from the log; the
backup holds those base states (and the compacted sequence prefixes), so restoring a
compacted device's backup on another device keeps every record and field, in merge and
replace mode, with or without a connection (manifest flags `includesFoldState` and
`compacted`). A format-2 file without these sections (written by a pre-release build) is rebuilt
on top of its rows instead (see `store.getSnapshotRecords()` in the
[conflict-resolution guide](/guide/conflict-resolution#what-changed-from-beta-12)).

A merge-mode restore never applies the server's own decisions from a file: operations of `kora:`
nodes and of the device's known server authorities are skipped (`result.serverOperationsSkipped`);
they arrive from the sync server.

The result reports failures instead of throwing for a file it cannot restore:
`result.success` is false and `result.errorCode` says why (`BACKUP_CHECKSUM_MISMATCH`,
`BACKUP_SCHEMA_NEWER` for a backup written by a newer schema version, or
`BACKUP_FORMAT_OUTDATED`).

### Backups made by beta.12 and earlier

Backups written by Kora 1.0.0-beta.12 and earlier use format version 1, whose restore
corrupted operation timestamps and copied the exporting device's identity. They are refused
with `errorCode: 'BACKUP_FORMAT_OUTDATED'`. Convert them once, then import the result:

```typescript
import { convertBackupV1 } from 'korajs'

const converted = await convertBackupV1(oldBackup)
await app.importBackup(converted)
```

`convertBackupV1` drops the device identity the old file carried and recovers timestamps a
previous version-1 restore had damaged. If an operation cannot be recovered the conversion
fails; pass `{ dropUnrecoverable: true }` to convert without it.

A database already damaged by a version-1 restore is repaired when the app opens: the store
checks its operation log on every open, rewrites timestamps it can recover, and moves rows it
cannot read to a quarantine table (`store:log-integrity` reports both). Call
`app.getStore().verifyLogIntegrity()` for a full report.

### Export Selected Collections

```typescript
const backup = await app.exportBackup({
  collections: ['projects', 'todos'],
  includeRecords: true,
  onProgress(progress) {
    console.log(progress.message)
  },
})
```

## Sync Server Backups

For synced apps, back up the server operation log with the CLI:

```bash
kora backup create --url http://localhost:3001 --out ./backup.kora
```

If the server has `KORA_BACKUP_TOKEN` or `KORA_ADMIN_TOKEN` configured, pass the token explicitly or expose it in your shell:

```bash
kora backup create --url https://sync.example.com --token "$KORA_BACKUP_TOKEN"
```

Restore it later:

```bash
kora backup restore ./backup.kora --url http://localhost:3001
```

Merge with existing server data instead of replacing it:

```bash
kora backup restore ./backup.kora --url http://localhost:3001 --merge
```

Inspect a backup file before restoring:

```bash
kora backup info ./backup.kora
```

The CLI talks to the sync server backup endpoints of `createProductionServer`:

- `POST /__kora/backup/export`
- `POST /__kora/backup/import?merge=true|false` (bodies above `maxBackupBytes`, 256 MiB by default, are refused)

Your sync server must be running and reachable from the machine running the CLI.
Production servers must protect backup endpoints with `KORA_BACKUP_TOKEN` or `KORA_ADMIN_TOKEN`
(`operationalAuth.backupToken` / `adminToken`): with `NODE_ENV=production` and neither set, the
backup endpoints are disabled (403). Imported operations go through the same ingest
validation as uploads.

A server backup also carries the users' end-to-end encryption key records (section
`encryption_keys`, wrapped keyrings only). A restore reconciles them record by record:

- **Replace mode** (`--merge` not given): the backup's record replaces the one the server holds
  for the same user and keyring, whatever its revision, so the server holds the keys its restored
  history was written under.
- **Merge mode**: a record the server lacks is added. A record of the same ring is advanced to the
  backup's when the backup's revision is newer and keeps every key the stored one has; a stored
  record that is as new or newer, or belongs to another ring (created after a loss), is kept.
- Records the backup does not name are kept in both modes.

The server cannot verify a key record (only a holder of the ring's master key can), and it does
not need to: every device authenticates a record before using it, refuses a revision older than
the one it accepted (and uploads its newer one again), and refuses a record its keys do not
authenticate. A rolled-back or forged record in a backup can delay a device; it cannot make one
adopt a key. A backup with a malformed key record is refused whole
(`BACKUP_INVALID_KEY_RECORD`). If you back up the server database by other means, include the
`kora_encryption_keys` table: without it, encrypted history waits for a device that holds the
keyring (see [Sync Encryption](/guide/sync-encryption#lost-key-records-and-forked-keyrings)).

After a server is restored from an older backup, connected devices notice that the server holds
fewer of their operations than it had acknowledged and re-upload them
(`sync:local-node`, `server-behind`), and devices whose delivery watermark is now ahead of the
server resync from the start.

## Recommended Practice

- Store server backups outside the application host.
- Test restores regularly against a staging server.
- Keep a backup before running schema migrations or changing sync scopes.
- If sync encryption is enabled, the server's backup holds only ciphertext and the users' wrapped keyrings: keep the passphrases (or recovery keys) safe, because nothing can decrypt the data without them.
- Treat backup files as sensitive data. They can contain application records and operation history.

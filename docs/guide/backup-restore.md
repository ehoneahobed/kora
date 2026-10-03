---
title: Backup and Restore
description: "Back up and restore Kora.js sync server data: backup commands, storage format, scheduling, and recovery workflows for offline-first apps."
---

# Backup and Restore

Kora supports two backup paths:

- **Local app backups** for a client database, using `app.exportBackup()` and `app.importBackup()`.
- **Sync server backups** for all synced operations on the server, using the `kora backup` CLI.

Use local app backups for user-controlled export/import, desktop app data portability, or support workflows. Use sync server backups for production operations, disaster recovery, and environment migration.

## Local App Backups

Every Kora app exposes backup methods after `app.ready` resolves:

```typescript
await app.ready

const backup = await app.exportBackup()
```

`backup` is a `Uint8Array` containing the operation log and metadata needed to restore the local store.

### Download a Backup in the Browser

```typescript
async function downloadBackup() {
  await app.ready
  const data = await app.exportBackup()
  const blob = new Blob([data], { type: 'application/octet-stream' })
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
replace mode, with or without a connection. Backups written by beta.12 carry no base
states: their records are rebuilt on top of the backup's rows instead (see
`store.getSnapshotRecords()` in the conflict-resolution guide).

The result reports failures instead of throwing for a file it cannot restore:
`result.success` is false and `result.errorCode` says why (`BACKUP_CHECKSUM_MISMATCH`,
`BACKUP_SCHEMA_NEWER` for a backup written by a newer schema version, or
`BACKUP_FORMAT_OUTDATED`).

### Backups made before beta.13

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

The CLI talks to the sync server backup endpoints:

- `POST /__kora/backup/export`
- `POST /__kora/backup/import?merge=true|false`

Your sync server must be running and reachable from the machine running the CLI.
Production servers should protect backup endpoints with `KORA_BACKUP_TOKEN` or `KORA_ADMIN_TOKEN`.

## Recommended Practice

- Store server backups outside the application host.
- Test restores regularly against a staging server.
- Keep a backup before running schema migrations or changing sync scopes.
- If sync encryption is enabled, keep encryption keys/passphrases safe. A backup cannot decrypt data without the correct key.
- Treat backup files as sensitive data. They can contain application records and operation history.

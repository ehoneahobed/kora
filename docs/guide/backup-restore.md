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

Use `merge: true` when you want to import without deleting existing local data. Use `merge: false` when you want the backup to replace the local store.

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

---
'@korajs/store': patch
'korajs': patch
---

`importBackup` converts a version-1 backup (Kora 1.0.0-beta.12 and earlier) itself, with the
rules of `convertBackupV1`, and reports `convertedFromVersion: 1` (F3). beta.13 returned
`success: false` with `BACKUP_FORMAT_OUTDATED`, which code that ignored the result never
noticed. A file holding an operation whose timestamp cannot be recovered is still refused
(`BACKUP_OPERATION_INVALID`): dropping operations stays an explicit `convertBackupV1` option.

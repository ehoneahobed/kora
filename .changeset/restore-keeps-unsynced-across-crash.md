---
'@korajs/store': patch
---

A replace-mode `importBackup` no longer loses this device's unsynced writes if the app stops partway through. The restore removes those writes from the log and applies them again after its transaction commits. They are now recorded in the same transaction, and the next open applies any that a crash left behind. In a local-only app with the default `keepUnsyncedWrites: true`, that is every write since the last backup. The restore also marks the restored collections for rebuilding in that same transaction, so a crash can no longer leave them without fold state.

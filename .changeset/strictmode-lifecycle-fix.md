---
"@korajs/react": patch
"@korajs/sync": patch
---

Fix React StrictMode breaking useMutation, useSyncStatus, and useRichText.

StrictMode's simulated unmount permanently destroyed the useMemo-cached
controller, so every mutation in a freshly scaffolded app silently failed
("Mutation controller is destroyed") and the sync badge stayed stuck on
"Offline". Controllers are now managed by a StrictMode-safe lifecycle
helper (useController) that recreates them on remount.

Also fix `korajs` failing to load in plain Node.js ESM: import
`protobufjs/minimal.js` with an explicit extension (protobufjs has no
exports map, so the extensionless subpath only resolves in bundlers).

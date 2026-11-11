---
"@korajs/cli": patch
"@korajs/store": patch
---

The Tauri template is ready for Tauri's iOS and Android targets: it has a mobile entry point, and the updater (desktop only) is left out of mobile builds in code, dependencies and capabilities. Its README says how to add mobile and how to deploy the sync server. `FilesystemBlobStore` reports its directory as `location`, so the production server's startup log names where files are kept.

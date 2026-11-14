---
'@korajs/tauri': minor
'@korajs/cli': patch
---

Desktop sign-in sessions live in the operating system's credential store. `createTauriCredentialStore()` keeps credentials in Keychain (macOS), Credential Manager (Windows) or the Secret Service (Linux) through new commands of the `kora-sqlite` plugin, included in its default permission. Pass it to `createAuthTokenStorage` for `createKoraAuth({ storage })`; the Tauri template now does. A session saved in WebView storage by an earlier version moves to the keychain on first read; where no credential store exists it falls back to WebView storage and warns once. The plugin needs Rust 1.88 or newer.

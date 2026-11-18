# @korajs/tauri

Native SQLite storage for Kora.js apps running in [Tauri 2](https://v2.tauri.app). Your app keeps the same schema, queries and sync as on the web, but with no WASM and no Web Worker: statements run in SQLite inside the app's Rust process. The package also stores sign-in credentials in the operating system's credential store.

It has two parts:

- **The TypeScript adapter** (this npm package): `TauriSqliteAdapter`, which `createApp` picks up by itself inside Tauri.
- **The Rust plugin** `tauri-plugin-kora-sqlite`, shipped inside the package at `plugin/`.

> The quickest start is the desktop template: `npx create-kora-app@beta my-app --platform desktop-tauri`. It comes with everything below already set up. The full guide is [Tauri Desktop Apps](https://korajs.dev/guide/tauri-desktop).

## Install

```bash
pnpm add @korajs/tauri@beta @tauri-apps/api
```

## Register the plugin

Reference the plugin from `node_modules` in `src-tauri/Cargo.toml`:

```toml
[dependencies]
tauri-plugin-kora-sqlite = { version = "0.1", path = "../node_modules/@korajs/tauri/plugin" }
```

Register it in `src-tauri/src/lib.rs`:

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_kora_sqlite::init())
```

## Grant the permission

Add `kora-sqlite:default` to `src-tauri/capabilities/default.json`:

```json
{
  "permissions": ["core:default", "kora-sqlite:default"]
}
```

`kora-sqlite:default` lets the app:

- open, query, migrate, inspect and close its databases;
- delete a closed database;
- read and write its own entries in the credential store.

## Use the adapter

Import the package once in your entry file. The import puts the adapter in the app's bundle (a webview can't load a package by name), and `createApp` then uses native SQLite whenever the app runs inside Tauri:

```typescript
import '@korajs/tauri'
import { createApp } from 'korajs'
import schema from './schema'

const app = createApp({ schema })
```

Without the import, `createApp` inside Tauri fails with an error that names this package.

The database is a file in the app's data directory, `kora-db.db` by default. `store: { name }` changes the name. Used directly, as with a `Store` you build yourself, `new TauriSqliteAdapter({ path })` takes a file name inside that directory, such as `kora.db` or `user/kora.db`. The plugin refuses:

- a parent (`..`), absolute or empty path;
- `ATTACH` and `VACUUM INTO`.

So even a compromised webview can't open or write a database file anywhere else on disk.

## Keep sign-ins in the credential store

The store is the Keychain on macOS, Credential Manager on Windows and the Secret Service on Linux:

```typescript
import { createAuthTokenStorage, createKoraAuth } from '@korajs/auth'
import { createTauriCredentialStore } from '@korajs/tauri'

const auth = createKoraAuth({
  serverUrl: 'https://sync.example.com',
  storage: createAuthTokenStorage({ store: createTauriCredentialStore(), durability: 'durable' }),
})
```

- Where there is no credential store, the store falls back to WebView storage and warns once. That covers mobile builds, a browser build of the app, and a Linux desktop without a Secret Service. `store.location` reports `keychain` or `fallback`.
- It needs Rust 1.88 or newer.

## Database files

- `inspectTauriDatabase(path)` reports whether a database is open in this app and whether its file exists.
- `readTauriDatabase(path, read)` reads a closed database without running schema statements.
- `deleteTauriDatabase(path)` permanently deletes a closed database. It throws `TauriDatabaseInUseError` while the database is open.
  - It doesn't check for unsynced data. To delete with that check, use `app.storage.deleteDatabase()`.

## Errors

Every error extends `KoraError`, so `error instanceof KoraError` and `error.code` work as they do in the rest of Kora:

| Code | Class | When |
|------|-------|------|
| `TAURI_ADAPTER_ERROR` | `TauriAdapterError` | A plugin call failed. Check the `kora-sqlite:default` permission and the plugin build. |
| `STORE_NOT_OPEN` | `TauriStoreNotOpenError` | The adapter was used before `open()`. |
| `TAURI_DATABASE_IN_USE` | `TauriDatabaseInUseError` | `deleteTauriDatabase` was called on an open database. |

## License

MIT

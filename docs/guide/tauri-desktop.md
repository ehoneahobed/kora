# Tauri Desktop Apps

Build native desktop applications with Kora.js using [Tauri](https://tauri.app). Your app gets native SQLite (no WASM, no Web Workers), a real filesystem, and a tiny binary — while keeping the same React code and sync capabilities as the web version.

## Prerequisites

Before you begin, install the Tauri prerequisites for your OS:

- **macOS**: Xcode Command Line Tools (`xcode-select --install`)
- **Windows**: Microsoft Visual Studio C++ Build Tools, WebView2
- **Linux**: System dependencies vary by distro — see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

You also need [Rust](https://rustup.rs/) installed:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

## Quick Start

Scaffold a Tauri desktop project:

```bash
npx create-kora-app my-desktop-app --platform desktop-tauri
```

Or select **Desktop (Tauri)** when prompted for platform:

```
? Platform:
  > Web (browser)
    Desktop (Tauri — native SQLite)
```

Then:

```bash
cd my-desktop-app
pnpm install
pnpm tauri dev
```

This opens a native window with your Kora app running inside. The first build takes a few minutes while Rust compiles — subsequent builds are fast.

## Project Structure

A Tauri project has the same structure as a web Kora project, plus a `src-tauri/` directory for the native shell:

```
my-desktop-app/
  src/
    schema.ts          # Data schema (same as web)
    main.tsx           # Kora app entry point
    App.tsx            # React UI
  src-tauri/
    Cargo.toml         # Rust dependencies
    tauri.conf.json    # Window size, title, build config
    capabilities/
      default.json     # Permissions for Tauri plugins
    src/
      main.rs          # Rust entry point
      lib.rs           # Plugin registration
  server.ts            # Sync server (optional)
  package.json
  vite.config.ts
```

## How It Works

### Native SQLite (No WASM)

On the web, Kora runs SQLite compiled to WebAssembly inside a Web Worker. In a Tauri app, Kora uses **native SQLite** through the `@korajs/tauri` package. This means:

- No WASM compilation overhead
- No Web Worker communication latency
- Direct filesystem access via OPFS or app data directories
- Faster queries, especially for large datasets

The adapter is auto-detected. When your app runs inside Tauri, `@korajs/tauri`'s `TauriSqliteAdapter` is used automatically — no configuration needed:

```typescript
import { createApp } from 'korajs'
import schema from './schema'

// Kora detects Tauri and uses native SQLite automatically
const app = createApp({ schema })
```

### Same React Code

Your React components, hooks, and schema are identical to a web Kora app. The only difference is the storage layer underneath:

```tsx
import { KoraProvider, useQuery, useMutation } from '@korajs/react'

function TodoList() {
  const todos = useQuery(app.todos.where({ completed: false }))
  const addTodo = useMutation(app.todos.insert)

  // Identical to web — works offline, syncs when connected
  return (
    <ul>
      {todos.map(todo => <li key={todo.id}>{todo.title}</li>)}
    </ul>
  )
}
```

### Sync Server

The Tauri template includes a `server.ts` for multi-device sync. Start it separately:

```bash
npx tsx server.ts
```

Then uncomment the sync configuration in `src/main.tsx`:

```typescript
const app = createApp({
  schema,
  sync: {
    url: import.meta.env.VITE_SYNC_URL || 'ws://localhost:3001',
  },
})
```

## Configuration

### Window Settings

Edit `src-tauri/tauri.conf.json` to customize the window:

```json
{
  "app": {
    "windows": [
      {
        "title": "My App",
        "width": 1024,
        "height": 768,
        "resizable": true,
        "fullscreen": false
      }
    ]
  }
}
```

### App Identity

Update the app identifier and product name:

```json
{
  "productName": "My App",
  "identifier": "com.mycompany.myapp"
}
```

### Capabilities

Tauri uses a capability system for security. The default capabilities in `src-tauri/capabilities/default.json` include:

```json
{
  "permissions": [
    "core:default",
    "opener:default",
    "kora-sqlite:default"
  ]
}
```

`kora-sqlite:default` grants the Kora SQLite plugin permission to read and write the local database.

## Building for Distribution

### Development

```bash
pnpm tauri dev
```

### Production Build

```bash
pnpm tauri build
```

This produces platform-specific installers:

| Platform | Output |
|----------|--------|
| macOS | `.dmg` and `.app` bundle |
| Windows | `.msi` and `.exe` installer |
| Linux | `.deb`, `.rpm`, `.AppImage` |

The built binaries are in `src-tauri/target/release/bundle/`.

## Differences from Web

| Feature | Web | Tauri Desktop |
|---------|-----|---------------|
| SQLite | WASM + Web Worker | Native (rusqlite) |
| Storage location | OPFS / IndexedDB | App data directory |
| Offline | Works offline | Always offline-capable |
| Binary size | N/A (browser) | ~5-10 MB |
| Auto-updates | N/A | Tauri updater plugin |
| File system access | Limited | Full (with permissions) |
| System tray | No | Yes (Tauri plugin) |

## Troubleshooting

### First build is slow

The first `pnpm tauri dev` compiles the Rust backend, which takes 2-5 minutes. Subsequent builds only recompile changed code and are much faster.

### `tauri-plugin-kora` not found

Make sure you've run `pnpm install` — the Tauri plugin is referenced from `node_modules/@korajs/tauri/plugin` in `Cargo.toml`.

### Window is blank

Check that Vite is running on port 5173. Tauri's dev config expects the frontend at `http://localhost:5173`. If Vite uses a different port, update `devUrl` in `tauri.conf.json`.

### Database location

In development, the database is stored in Tauri's app data directory:

- **macOS**: `~/Library/Application Support/com.kora.app/`
- **Windows**: `%APPDATA%/com.kora.app/`
- **Linux**: `~/.local/share/com.kora.app/`

## What's Next

- [Schema Design](/guide/schema-design) — Field types and relations
- [Sync Configuration](/guide/sync-configuration) — Connect desktop apps to a sync server
- [Deployment](/guide/deployment) — Deploy the sync server
- [Common Patterns](/guide/common-patterns) — Real-world patterns for offline-first apps

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
pnpm dev
```

This starts both the **sync server** and the **Tauri desktop app**. The first build takes a few minutes while Rust compiles — subsequent builds are fast.

Once the native window opens, you have a working offline-first app with sync ready to go.

## Project Structure

```
my-desktop-app/
  src/
    schema.ts          # Schema entry point
    main.tsx           # Kora app entry (sync enabled)
    App.tsx            # React UI
    modules/
      todos/
        todo.schema.ts     # Collection definition
        todo.queries.ts    # Query builders
        todo.mutations.ts  # Mutation helpers
        useTodos.ts        # React hook for the feature
  src-tauri/
    Cargo.toml         # Rust dependencies
    tauri.conf.json    # Window size, title, build config
    capabilities/
      default.json     # Permissions for Tauri plugins
    src/
      main.rs          # Rust entry point
      lib.rs           # Plugin registration
  server.ts            # Sync server
  dev.ts               # Dev orchestrator (starts sync + Tauri)
  kora.config.ts       # Kora configuration
  package.json
  vite.config.ts
```

## How It Works

### Native SQLite (No WASM)

On the web, Kora runs SQLite compiled to WebAssembly inside a Web Worker. In a Tauri app, Kora uses **native SQLite** through the `@korajs/tauri` package. This means:

- No WASM compilation overhead
- No Web Worker communication latency
- Direct filesystem access via app data directories
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

### Built-In Sync

The Tauri template comes with sync **enabled by default**. When you run `pnpm dev`, both the desktop app and a local sync server start together. The app connects to the server automatically.

```typescript
// src/main.tsx — sync is configured out of the box
const syncUrl = import.meta.env.VITE_SYNC_URL || 'ws://localhost:3001/kora-sync'

const app = createApp({
  schema,
  sync: { url: syncUrl },
})

app.ready.then(() => app.sync?.connect())
```

To test sync locally, open two instances of the app (run `pnpm dev:app` in a second terminal). Changes in one window appear in the other instantly.

## Development

### Single Command

```bash
pnpm dev
```

Starts both the sync server (port 3001) and the Tauri app together. This is the recommended way to develop.

### Individual Commands

If you need to start components separately:

```bash
pnpm dev:server    # Start sync server only
pnpm dev:app       # Start Tauri app only
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

## First-Launch Setup

On first launch, the app shows a setup screen where users enter their sync server URL:

1. **User enters the URL** provided by their organization admin (e.g., `wss://acme-corp.example.com/kora-sync`)
2. **App tests the connection** and saves the URL locally
3. **Subsequent launches** connect automatically — no repeated setup

Users can also skip setup to use the app in local-only mode. They can connect later from the settings gear icon in the header.

This means you can **distribute one binary to multiple organizations**. Each organization deploys their own sync server, and users configure it on first launch.

### Pre-configuring the Sync URL

If you're building for a specific organization, you can bake in the URL at build time:

```bash
VITE_SYNC_URL=wss://acme-corp.example.com/kora-sync pnpm build
```

When `VITE_SYNC_URL` is set, the setup screen is skipped and the app connects automatically.

## Authentication

Desktop apps use the same `@korajs/auth` client and sync-token flow as web apps. The Tauri frontend runs in a WebView, so `createKoraAuth`, `@korajs/auth/react`, token refresh, and sync authorization work normally.

Create an auth client that points at the same remote server that hosts your auth routes:

```typescript
import { createKoraAuth } from '@korajs/auth'

export const authClient = createKoraAuth({
  serverUrl: 'https://acme-corp.example.com',
})
```

For production apps, pass a secure desktop credential store:

```typescript
import { createKoraAuth } from '@korajs/auth'

export const authClient = createKoraAuth({
  serverUrl: 'https://acme-corp.example.com',
  credentialStore: tauriSecureStore,
})
```

Pass the auth token into sync when creating the Kora app:

```typescript
const app = createApp({
  schema,
  sync: {
    url: 'wss://acme-corp.example.com/kora-sync',
    auth: async () => ({
      token: (await authClient.getAccessToken()) ?? '',
    }),
  },
})
```

On the server, wire `authRoutes.toSyncAuthProvider()` through `syncOptions.auth`:

```typescript
const server = createProductionServer({
  store,
  syncPath: '/kora-sync',
  syncOptions: {
    auth: authRoutes.toSyncAuthProvider(),
  },
})
```

Email/password auth, OAuth sign-in, account linking, session refresh, MFA, org membership, and RBAC apply to desktop and web clients the same way. Passkeys require WebAuthn support in the operating system WebView, so call `isPasskeySupported()` before showing passkey UI. For OAuth, desktop apps need an app-specific redirect strategy such as a loopback callback, custom URL scheme, or hosted sign-in handoff, then should complete the flow with `POST /auth/oauth/:provider/callback`.

## Deploying for Multi-Device Sync

A desktop app that syncs across devices needs two things:

1. **A sync server** deployed to the internet
2. **The desktop binary** distributed to users

### Step 1: Deploy the sync server

The sync server is a lightweight Node.js process. Deploy it the same way you'd deploy a web Kora app:

```bash
pnpm deploy:server
```

This runs `kora deploy`, which supports:

| Platform | Command |
|----------|---------|
| Fly.io (recommended) | `kora deploy --platform=fly` |
| Railway | `kora deploy --platform=railway` |
| AWS Lightsail | `kora deploy --platform=aws-lightsail` |
| AWS ECS Fargate | `kora deploy --platform=aws-ecs` |

Follow the interactive prompts. When done, you'll get a URL like `https://my-app.fly.dev`.

::: tip First time deploying?
See the [Deployment Guide](/guide/deployment) for detailed step-by-step instructions, including how to install the Fly.io CLI and create an account.
:::

### Step 2: Build the desktop binary

```bash
pnpm build
```

Users configure the sync server on first launch — no need to bake in a URL. If you want to pre-configure it for a specific organization:

```bash
VITE_SYNC_URL=wss://my-app.fly.dev/kora-sync pnpm build
```

::: warning Use `wss://` (not `ws://`) for production
Production servers should always use HTTPS/WSS. Fly.io, Railway, and AWS provide TLS automatically.
:::

### Step 3: Distribute the binary

The built installers are in `src-tauri/target/release/bundle/`:

| Platform | Output |
|----------|--------|
| macOS | `.dmg` and `.app` bundle |
| Windows | `.msi` and `.exe` installer |
| Linux | `.deb`, `.rpm`, `.AppImage` |

Share these with your users. On first launch, each user enters the sync server URL provided by their admin.

### Step 4: Verify sync works

Install the app on two devices. Enter the same sync server URL on both. Create data on one device — it should appear on the other within a second or two. Data also works completely offline — changes sync when connectivity returns.

### Managing the deployed server

```bash
pnpm deploy:server status     # Check health and URL
pnpm deploy:server logs       # View server logs
pnpm deploy:server rollback   # Revert to previous deploy
```

### Using PostgreSQL in production

For production deployments, PostgreSQL is recommended over SQLite. The generated `server.ts` already supports both stores: it uses SQLite when `DATABASE_URL` is empty and PostgreSQL when `DATABASE_URL` is set.

```typescript
import {
  createPostgresServerStore,
  createProductionServer,
  createSqliteServerStore,
} from '@korajs/server'
import schema from './src/schema'

const store = process.env.DATABASE_URL
  ? await createPostgresServerStore({ connectionString: process.env.DATABASE_URL })
  : createSqliteServerStore({ filename: process.env.KORA_SERVER_DB || './kora-server.db' })

await store.setSchema(schema)

const server = createProductionServer({
  store,
  port: Number(process.env.PORT) || 3001,
  syncPath: '/kora-sync',
  operationalAuth: {
    adminToken: process.env.KORA_ADMIN_TOKEN,
    metricsToken: process.env.KORA_METRICS_TOKEN,
    backupToken: process.env.KORA_BACKUP_TOKEN,
  },
})

server.start()
```

Set `DATABASE_URL` in your deployment environment. Most cloud platforms (Neon, Supabase, Railway) provide managed PostgreSQL with a connection string. Set `KORA_ADMIN_TOKEN`, `KORA_METRICS_TOKEN`, and `KORA_BACKUP_TOKEN` before exposing `/__kora/*` endpoints on the public internet.

## Auto-Updates

The template includes `tauri-plugin-updater` for automatic updates. When you release a new version, installed apps detect and install the update automatically.

### Setup

1. **Generate signing keys** (one-time):

   ```bash
   pnpm tauri signer generate -w ~/.tauri/myapp.key
   ```

2. **Add the public key** to `src-tauri/tauri.conf.json`:

   ```json
   "plugins": {
     "updater": {
       "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ...",
       "endpoints": [
         "https://github.com/YOUR_ORG/YOUR_REPO/releases/latest/download/latest.json"
       ]
     }
   }
   ```

3. **Add secrets** to your GitHub repo:
   - `TAURI_SIGNING_PRIVATE_KEY` — contents of `~/.tauri/myapp.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — password used during generation

### Releasing

Push a version tag to trigger the CI/CD workflow:

```bash
# Update version in src-tauri/tauri.conf.json and package.json
git tag v1.0.0
git push origin v1.0.0
```

The included GitHub Actions workflow (`.github/workflows/release-desktop.yml`) builds for macOS (ARM + Intel), Windows, and Linux, then creates a GitHub Release with all installers plus an `latest.json` update manifest.

### How it works

On each app launch, the updater checks the endpoint for a newer version. If found, it downloads and installs the update. The app restarts with the new version. If the network is unavailable, the check is silently skipped — the app works fully offline.

## CI/CD for Desktop Releases

The template includes a GitHub Actions workflow at `.github/workflows/release-desktop.yml` that automates cross-platform builds.

### What it does

1. Builds for macOS (aarch64 + x86_64), Windows, and Linux
2. Signs the binaries (if signing secrets are configured)
3. Creates a draft GitHub Release with all installers
4. Generates the `latest.json` manifest for auto-updates

### Code Signing

For professional distribution, you'll want to sign your binaries:

**macOS** — Requires an Apple Developer ID certificate ($99/year):
- Prevents Gatekeeper from blocking your app
- Required for notarization (recommended for all distributed macOS apps)
- Add `APPLE_CERTIFICATE`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` to GitHub secrets

**Windows** — An EV code signing certificate ($200-400/year from DigiCert, Sectigo, etc.):
- Prevents SmartScreen warnings
- Builds user trust

Without code signing, users will see "unidentified developer" warnings. The app still works — users just have to click through the warning.

## Building for Distribution

### Development

```bash
pnpm dev
```

### Production Build

```bash
pnpm build
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
| Sync | Same | Same |
| Deploy target | Web host + sync server | Binary distribution + sync server |

## Troubleshooting

### First build is slow

The first `pnpm dev` compiles the Rust backend, which takes 2-5 minutes. Subsequent builds only recompile changed code and are much faster.

### `tauri-plugin-kora` not found

Make sure you've run `pnpm install` — the Tauri plugin is referenced from `node_modules/@korajs/tauri/plugin` in `Cargo.toml`.

### Window is blank

Check that Vite is running on port 5173. Tauri's dev config expects the frontend at `http://localhost:5173`. If Vite uses a different port, update `devUrl` in `tauri.conf.json`.

### Sync not connecting

1. Make sure the sync server is running (`pnpm dev` starts it automatically)
2. Check the console for connection errors
3. Verify `VITE_SYNC_URL` in `.env` matches the sync server address

### Database location

In development, the database is stored in Tauri's app data directory:

- **macOS**: `~/Library/Application Support/com.kora.app/`
- **Windows**: `%APPDATA%/com.kora.app/`
- **Linux**: `~/.local/share/com.kora.app/`

## What's Next

- [Schema Design](/guide/schema-design) — Field types and relations
- [Sync Configuration](/guide/sync-configuration) — Advanced sync options
- [Deployment](/guide/deployment) — Full deployment guide with platform details
- [Common Patterns](/guide/common-patterns) — Real-world patterns for offline-first apps

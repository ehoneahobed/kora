---
title: Tauri Desktop Apps
description: "Ship Kora.js apps as native desktop applications with Tauri: native SQLite storage, the @korajs/tauri plugin, and desktop setup."
---

# Tauri Desktop Apps

Build native desktop applications with Kora.js using [Tauri](https://tauri.app). Your app gets native SQLite (no WASM, no Web Workers), a real filesystem, and a tiny binary, while keeping the same React code and sync capabilities as the web version.

## Prerequisites

Before you begin, install the Tauri prerequisites for your OS:

- **macOS**: Xcode Command Line Tools (`xcode-select --install`)
- **Windows**: Microsoft Visual Studio C++ Build Tools, WebView2
- **Linux**: System dependencies vary by distro. See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

You also need [Rust](https://rustup.rs/) installed:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

## Quick Start

Scaffold a Tauri desktop project:

```bash
npx create-kora-app@beta my-desktop-app --platform desktop-tauri
```

Or select **Desktop (Tauri)** when prompted for platform:

```
? Platform:
  > Web (browser)
    Desktop (Tauri - native SQLite)
```

Then:

```bash
cd my-desktop-app
pnpm dev
```

This starts both the **sync server** and the **Tauri desktop app**. The first build takes a few minutes while Rust compiles; subsequent builds are fast.

Once the native window opens, you have a working offline-first app with sync ready to go.

## Project Structure

```
my-desktop-app/
  src/
    schema.ts          # Schema entry point
    main.tsx           # React entry (imports @korajs/tauri)
    AppShell.tsx       # First-launch setup, then the Kora app (sync when a URL is set)
    SetupScreen.tsx    # Sync server URL entry
    sync-config.ts     # Stored sync URL
    auth.ts            # Desktop auth client (sessions in the OS credential store)
    AuthBridge.tsx     # Sign-in UI, loaded after the first paint
    updater.ts         # Update check
    UpdateBanner.tsx   # Offers a newer version: Install or Later
    OfflineBadge.tsx   # Offline status, from useOfflineReady()
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
      default.json     # Permissions for every platform
      desktop.json     # The updater permission, desktop only
    src/
      main.rs          # Rust entry point
      lib.rs           # Plugin registration and the mobile entry point
  server.ts            # Sync server
  dev.ts               # Dev orchestrator (starts sync + Tauri)
  .github/workflows/release-desktop.yml  # Cross-platform release builds
  .gitignore           # Keeps .env files, local databases and src-tauri/target out of git
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

The adapter is auto-detected. When your app runs inside Tauri, `@korajs/tauri`'s `TauriSqliteAdapter` is used automatically. The one requirement is that your entry file imports `@korajs/tauri`, which puts the adapter in the app's bundle (a webview cannot load a package by name). The `tauri-react` template already does this in `src/main.tsx`:

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
const schema = defineSchema({ version: 1, collections: { todos: { fields: { title: t.string(), completed: t.boolean().default(false) } } } })
-->

```typescript
import '@korajs/tauri'

// Kora detects Tauri and uses native SQLite
const app = createApp({ schema })
```

Without the import, `createApp` inside Tauri fails with an error that names it.

### Same React Code

Your React components, hooks, and schema are identical to a web Kora app. The only difference is the storage layer underneath:

```tsx
import { useMutation, useQuery } from '@korajs/react'

const app = createApp({ schema })

function TodoList() {
  const todos = useQuery(app.todos.where({ completed: false }))
  const addTodo = useMutation(app.todos.insert)

  // Identical to web: works offline, syncs when connected
  return (
    <ul>
      {todos.map((todo) => <li key={todo.id}>{todo.title}</li>)}
      <button onClick={() => addTodo.mutate({ title: 'New todo' })}>Add</button>
    </ul>
  )
}
```

### Built-In Sync

`pnpm dev` starts the desktop app and a local sync server together. The app (`src/AppShell.tsx`)
creates the Kora app with sync when it has a sync URL (from `VITE_SYNC_URL` or the first-launch
setup screen) and calls `app.sync?.connect()` at once: the socket opens while the local database
does. The sign-in client loads after the first paint:

<!-- docs-check: skip excerpt of the template's AppShell component -->
```typescript
createApp({
  schema,
  ...(syncUrl
    ? {
        sync: {
          url: syncUrl,
          authClient: lazyAuthSync(() => import('./auth').then((m) => m.getDesktopAuth(syncUrl).authSync)),
        },
      }
    : {}),
  devtools: import.meta.env.DEV,
})
```

As in the web sync templates, sync is bound to the signed-in user: until someone signs in, the app
works locally and sync waits (`auth-required`). Configure auth on the server (`KORA_AUTH_SECRET`,
see [Authentication](#authentication)), or pass `anonymous: 'allow'` to `createKoraAuthSync` for a
shared-data demo. Then open a second instance (`pnpm dev:app` in another terminal) to watch changes
sync.

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

`create-kora-app` names the app after the project (`productName`) and gives it its own identifier, `com.<project-name>`. Set the identifier to your own reverse-DNS id before you ship:

```json
{
  "productName": "My App",
  "identifier": "com.mycompany.myapp"
}
```

The identifier decides where the app keeps its data (on macOS, `~/Library/Application Support/<identifier>/`), including the local database. Two apps with the same identifier share one database, and changing it after release leaves your users' data behind under the old one. Apps scaffolded before 1.0.0-beta.15 all used `com.kora.app`: `kora doctor` warns about it.

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

`kora-sqlite:default` lets the app open, query, migrate, inspect and close its databases, delete a
closed database, and read and write its own entries in the credential store. The template grants
`updater:default` in a separate `desktop.json` limited to Linux, macOS and Windows, so mobile
builds leave the updater out.

## First-Launch Setup

On first launch, the app shows a setup screen where users enter their sync server URL:

1. **User enters the URL** provided by their organization admin (e.g., `wss://acme-corp.example.com/kora-sync`)
2. **App tests the connection** and saves the URL locally
3. **Subsequent launches** connect automatically, no repeated setup

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

The WebView loads the app from its own origin (`tauri://localhost` on macOS and Linux, `http://tauri.localhost` on Windows), so every call to the server's auth routes is cross-origin. `createProductionServer` allows those origins (and `http://localhost` in development) for its HTTP routes and `/health`, with no credentials, since Kora Auth sends bearer tokens. A server older than 1.0.0-beta.15 does not, and sign-in from the desktop app fails with a network error. To allow another origin, such as a web build on its own domain, pass `allowedOrigins` or set `KORA_ALLOWED_ORIGINS`.

Create an auth client that points at the same remote server that hosts your auth routes:

```typescript
import { createKoraAuth } from '@korajs/auth'

export const authClient = createKoraAuth({
  serverUrl: 'https://acme-corp.example.com',
})
```

Keep sessions in the operating system's credential store (Keychain on macOS, Credential Manager on Windows, the Secret Service on Linux) rather than WebView storage. `@korajs/tauri` provides one, through the same `kora-sqlite` plugin and its default permission; the template uses it:

```typescript
import { createAuthTokenStorage, createKoraAuth } from '@korajs/auth'
import { createTauriCredentialStore } from '@korajs/tauri'

export const secureAuthClient = createKoraAuth({
  serverUrl: 'https://acme-corp.example.com',
  storage: createAuthTokenStorage({ store: createTauriCredentialStore(), durability: 'durable' }),
})
```

- Entries are kept under the app's bundle identifier, and keychain calls run off the UI thread.
- A session an earlier version of the app saved in WebView storage moves to the keychain on first read, so upgrading signs nobody out.
- Where there is no credential store (mobile builds today, a browser build of the app, a Linux desktop without a Secret Service), the store falls back to WebView storage and warns once. `store.location` reports `keychain` or `fallback`.
- It needs Rust 1.88 or newer.

Bind it to sync when creating the Kora app:

<!-- docs-check: continue -->
```typescript
import { createKoraAuthSync } from '@korajs/auth'
import { createApp, defineSchema, t } from 'korajs'

const schema = defineSchema({ version: 1, collections: { todos: { fields: { title: t.string() } } } })

const app = createApp({
  schema,
  sync: {
    url: 'wss://acme-corp.example.com/kora-sync',
    authClient: createKoraAuthSync({ authClient: secureAuthClient, schema }),
    autoConnect: true,
  },
})
```

On the server, mount the auth routes and pass the auth server's sync provider:

<!-- docs-check: standalone -->
```typescript
import { createKoraAuthServer, createSqliteUserStore } from '@korajs/auth/server'
import { createProductionServer, createSqliteServerStore } from '@korajs/server'

const auth = createKoraAuthServer({
  jwtSecret: process.env.KORA_AUTH_SECRET,
  userStore: await createSqliteUserStore({ filename: './kora-auth.db' }),
})

const server = createProductionServer({
  store: createSqliteServerStore({ filename: './kora-server.db' }),
  syncPath: '/kora-sync',
  httpRoutes: [auth.httpRoute],
  syncOptions: { auth: auth.auth },
})
```

Email/password auth, OAuth sign-in, account linking, session refresh, MFA, org membership, and RBAC apply to desktop and web clients the same way. Passkeys require WebAuthn support in the operating system WebView, so call `isPasskeySupported()` before showing passkey UI. For OAuth, desktop apps need an app-specific redirect strategy such as a loopback callback, custom URL scheme, or hosted sign-in handoff: create the URL with `authClient.getOAuthAuthorizationUrl(provider, { redirect: false })`, open it in the system browser, and finish with `authClient.completeOAuthSignIn(provider, { code, state })`.

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
| Kora Cloud | `kora deploy --platform kora-cloud --prod` (after `kora login`) |
| Fly.io | `kora deploy --platform=fly` |
| Railway | `kora deploy --platform=railway` |
| AWS Lightsail | `kora deploy --platform=aws-lightsail` |
| AWS ECS Fargate | `kora deploy --platform=aws-ecs` |

Follow the interactive prompts. When done, you'll get a URL like `https://my-app.fly.dev`. Only the
server is deployed: the app itself ships as a download (or through the app stores).

::: tip First time deploying?
See the [Deployment Guide](/guide/deployment) for detailed step-by-step instructions, including how to install the Fly.io CLI and create an account.
:::

### Step 2: Build the desktop binary

```bash
pnpm build
```

Users configure the sync server on first launch, no need to bake in a URL. If you want to pre-configure it for a specific organization:

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

Install the app on two devices. Enter the same sync server URL on both. Create data on one device. It should appear on the other within a second or two. Data also works completely offline. Changes sync when connectivity returns.

### Managing the deployed server

```bash
pnpm deploy:server status     # Check health and URL
pnpm deploy:server logs       # View server logs
pnpm deploy:server restart    # Start the running version again (Kora Cloud)
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
import { defineSchema, t } from 'korajs'

const schema = defineSchema({ version: 1, collections: { todos: { fields: { title: t.string() } } } })

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

The template includes `tauri-plugin-updater`. When you release a new version, installed apps find it and offer it; nothing is installed until the user agrees.

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
   - `TAURI_SIGNING_PRIVATE_KEY`: contents of `~/.tauri/myapp.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: password used during generation

Installed apps download `latest.json` and the installers without signing in, so the release must
be public. For a private repository, publish them somewhere public and point the endpoint there.

### Releasing

Push a version tag to trigger the CI/CD workflow:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The tag is the version: before building, the workflow writes it into `package.json`,
`src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, and refuses a tag that is not a version
(`v1.2.3`). A release started by hand uses the tag you type in. The included GitHub Actions
workflow (`.github/workflows/release-desktop.yml`) builds for macOS (ARM + Intel), Windows, and
Linux, then creates a draft GitHub Release with all installers plus a `latest.json` update
manifest. It turns on `createUpdaterArtifacts` for its own builds only, so a local `pnpm build`
works without the signing key.

### How it works

On launch, `checkForUpdate()` (`src/updater.ts`) asks the endpoint and reports what it found: up to date, a newer version, or why it could not check (offline, updates not set up for this build, a signature that did not match). When a newer signed version exists, `<UpdateBanner />` offers it with **Install** and **Later**; it is downloaded and installed only after the user chooses Install. A failed check never blocks the app, so it works fully offline.

## CI/CD for Desktop Releases

The template includes a GitHub Actions workflow at `.github/workflows/release-desktop.yml` that automates cross-platform builds.

### What it does

1. Builds for macOS (aarch64 + x86_64), Windows, and Linux
2. Signs the binaries (if signing secrets are configured)
3. Creates a draft GitHub Release with all installers
4. Generates the `latest.json` manifest for auto-updates

### Code Signing

For professional distribution, you'll want to sign your binaries:

**macOS** requires an Apple Developer ID certificate ($99/year):
- Prevents Gatekeeper from blocking your app
- Required for notarization (recommended for all distributed macOS apps)
- Add `APPLE_CERTIFICATE`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` to GitHub secrets

**Windows** needs an EV code signing certificate ($200-400/year from DigiCert, Sectigo, etc.):
- Prevents SmartScreen warnings
- Builds user trust

Without code signing, users will see "unidentified developer" warnings. The app still works; users just have to click through the warning.

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

## Mobile (iOS and Android)

The template has a mobile entry point (`#[cfg_attr(mobile, tauri::mobile_entry_point)]` in
`src-tauri/src/lib.rs`), so the same app builds for Tauri's iOS and Android targets with the same
local database, sync and offline behaviour. In-app updates are desktop only (phones update through
their app stores): the updater is left out of mobile builds in code, dependencies and
capabilities.

```bash
npx tauri ios init        # needs Xcode
npx tauri ios dev
npx tauri android init    # needs Android Studio and the NDK
npx tauri android dev
```

The OS credential store is not used on mobile yet: sessions fall back to WebView storage (see
[Authentication](#authentication)).

## Local data on the device

- **Erasing one device's copy.** `app.storage.deleteDatabase()` works in Tauri apps: it deletes
  the database file and SQLite's companion files from the app's data directory, with the same
  refusals as in a browser (an open database, unsynced writes unless `force`). Use it for a "reset
  this device" button: unlike deleting records, it writes nothing that syncs to other devices.
  `@korajs/tauri` also exports `inspectTauriDatabase`, `readTauriDatabase` and
  `deleteTauriDatabase` for files you manage yourself.
- **Durability.** The plugin runs SQLite with `synchronous = FULL`, so a write whose promise
  resolved survives an operating-system crash or power loss.
- **Binary values.** Rich text and blobs round-trip through the plugin as real BLOBs. Update the
  Rust plugin together with the npm package (rebuild the app) when you upgrade.
- **Offline status.** A native build has no service worker: `app.offline.status().shell` reports
  `bundled`, since the app's files ship inside the binary.
- **Tabs and builds.** Tauri apps are not subject to the browser version gate: one process owns
  the database file.

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

### `tauri-plugin-kora-sqlite` not found

Make sure you've run `pnpm install`: the Tauri plugin is referenced from `node_modules/@korajs/tauri/plugin` in `Cargo.toml`.

### Window is blank

Check that Vite is running on port 5173. Tauri's dev config expects the frontend at `http://localhost:5173`. If Vite uses a different port, update `devUrl` in `tauri.conf.json`.

### Sync not connecting

1. Make sure the sync server is running (`pnpm dev` starts it automatically)
2. Check the console for connection errors
3. Verify `VITE_SYNC_URL` in `.env` matches the sync server address
4. If sign-in fails with a network error while the server answers in a browser, the server doesn't allow the app's origin: upgrade `@korajs/server`, or add the origin to `KORA_ALLOWED_ORIGINS`

### Database location

The database is stored in Tauri's app data directory, named after the `identifier` in
`src-tauri/tauri.conf.json` (the template derives it from your project name):

- **macOS**: `~/Library/Application Support/<identifier>/`
- **Windows**: `%APPDATA%/<identifier>/`
- **Linux**: `~/.local/share/<identifier>/`

`TauriSqliteAdapter({ path })` takes a file name inside that directory, such as `kora.db` or
`user/kora.db`. The plugin refuses a parent (`..`), absolute or empty path, and it refuses
`ATTACH` and `VACUUM INTO`, so even a compromised webview cannot open or write a database file
elsewhere on disk.

## What's Next

- [Schema Design](/guide/schema-design): Field types and relations
- [Sync Configuration](/guide/sync-configuration): Advanced sync options
- [Deployment](/guide/deployment): Full deployment guide with platform details
- [Common Patterns](/guide/common-patterns): Real-world patterns for offline-first apps

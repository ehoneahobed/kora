# Kora.js Desktop & Mobile Implementation Plan

## Context

Kora.js is an offline-first application framework. The core promise — write data locally, sync when connected — is even more valuable on desktop and mobile than on the web. Desktop apps can use native SQLite (faster, no WASM overhead), and mobile apps operate in environments where connectivity is intermittent by default.

The `@korajs/tauri` package already exists with a working native SQLite adapter and Rust plugin. This plan covers making it production-ready, creating developer tooling, and extending the pattern to other platforms.

---

## Architecture: Zero-Bloat Platform Strategy

The existing architecture already prevents cross-platform bloat. This must be preserved as we add more platforms.

### How It Works Today

```
Developer installs:        What goes in their bundle:
─────────────────────      ────────────────────────────
korajs (web app)       →   core + store + merge + sync (50KB gzip)
                           sqlite-wasm loaded on demand
                           NO tauri, NO better-sqlite3, NO native code

korajs (Tauri app)     →   core + store + merge + sync (50KB gzip)
                           @korajs/tauri loaded via dynamic import
                           NO sqlite-wasm, NO indexeddb adapter

korajs (server)        →   core + sync + merge (30KB gzip)
                           better-sqlite3 or postgres via @korajs/server
```

### Principles for All New Platforms

1. **Separate package** — every platform adapter is its own `@korajs/<platform>` package
2. **Optional peer deps** — platform SDKs (`@tauri-apps/api`, `react-native`, etc.) are peer optional
3. **Dynamic import** — `adapter-resolver.ts` uses `new Function('specifier', 'return import(specifier)')` to prevent bundlers from statically analyzing platform-specific imports
4. **Runtime detection** — `detectAdapterType()` checks environment globals, never `import`
5. **CLI templates per platform** — `create-kora-app` only installs what's needed for the chosen platform

**Rule: Adding a new platform adapter must add ZERO bytes to existing platform bundles.**

---

## Phase 1: Tauri Desktop (Polish & Ship)

**Goal:** A developer can run `npx create-kora-app my-app --template tauri` and have a working offline-first desktop app with sync in under 10 minutes.

### 1.1 CLI Template: `tauri`

Create `packages/cli/templates/tauri/` with:

```
tauri/
  src/
    main.tsx              # createApp() — same as web, auto-detects Tauri
    App.tsx               # Working todo app UI (same quality as react-tailwind-sync)
    schema.ts             # Shared schema
    auth.ts               # AuthClient setup
  src-tauri/
    Cargo.toml            # Include tauri-plugin-kora dependency
    src/
      main.rs             # Tauri builder with kora plugin registered
      lib.rs              # Plugin initialization
    capabilities/
      default.json        # IPC permissions for kora-sqlite
    tauri.conf.json       # Window config, app metadata
  server.ts               # Sync server (same pattern as web templates)
  package.json            # korajs + @korajs/tauri + @tauri-apps/api
  vite.config.ts          # Vite config for Tauri
  tsconfig.json
```

**Key decisions:**
- Template includes sync server (desktop apps almost always need sync to a central database)
- The frontend code is identical to web — demonstrating code reuse
- The `src-tauri/` directory contains all Rust/native configuration
- `package.json` includes `@korajs/tauri` as a dependency and `@tauri-apps/api` as a dependency (not optional — it's a Tauri template, the user chose this platform)

### 1.2 CLI Scaffold Integration

Update `packages/cli/src/commands/create.ts`:

```typescript
// Add to template options
const templates = [
  { label: 'React + Tailwind (with sync)', value: 'react-tailwind-sync' },
  { label: 'React + Tailwind (local only)', value: 'react-tailwind' },
  { label: 'Tauri Desktop (with sync)', value: 'tauri' },
  // ...
]
```

Post-scaffold steps for Tauri template:
1. Install npm dependencies
2. Check if Rust toolchain is installed (`rustc --version`)
3. If not, print instructions: "Install Rust: https://rustup.rs"
4. Print next steps: `cd my-app && pnpm tauri dev`

### 1.3 Tauri Plugin Distribution

**Current problem:** The Rust plugin source is at `packages/tauri/plugin/`. Developers need to reference it in their `Cargo.toml`, but the path depends on where `node_modules` lives.

**Solution:** Publish the Rust crate to crates.io as `tauri-plugin-kora`.

Then developers can simply:
```toml
# src-tauri/Cargo.toml
[dependencies]
tauri-plugin-kora = "0.1"
```

No path gymnastics, no node_modules references.

**Steps:**
- Add `tauri-plugin-kora` to crates.io publish workflow
- Update the template to use the crates.io version
- Keep the source in `packages/tauri/plugin/` for monorepo development
- Add a GitHub Actions step to publish to crates.io on Kora releases

### 1.4 Documentation: Tauri Guide

Create `docs/guide/tauri-desktop.md`:

**Sections:**
1. Prerequisites (Rust toolchain, Tauri CLI)
2. Quick start with template
3. Manual setup (adding Kora to existing Tauri project)
4. How storage works (native SQLite via IPC, WAL mode, data location)
5. Sync configuration (same as web — wss:// URL)
6. Building for distribution (code signing, auto-updater)
7. Differences from web (no WASM overhead, native file system access, larger SQLite limits)

### 1.5 Update Existing Docs

- `docs/guide/storage-configuration.md` — add `tauri-sqlite` adapter section
- `docs/api/store.md` — add Tauri adapter to adapter table
- `docs/getting-started.md` — mention desktop option in the "Choose your platform" section
- `docs/.vitepress/config.ts` — add Tauri guide to sidebar

### 1.6 Testing

- Add E2E test: Tauri app boots, inserts record, queries it, closes
- Add sync test: Tauri app connects to test server, syncs data
- Verify: web template still produces zero Tauri code in bundle (bundle analysis)

**Estimated scope:** ~3-4 focused sessions

---

## Phase 2: Electron Support

**Goal:** Kora works in Electron apps using `better-sqlite3` (native Node.js SQLite).

### 2.1 Why Electron?

- Massive existing ecosystem (VS Code, Slack, Discord, etc.)
- `better-sqlite3` already works in the store package
- `detectAdapterType()` already detects Node.js and selects `better-sqlite3`
- **Electron apps work TODAY with zero code changes** — they just use the Node.js adapter

### 2.2 What's Actually Needed

Electron support mostly works already. What's missing:

1. **CLI template: `electron`** — scaffolds an Electron app with Kora
2. **Documentation** — guide for setting up Electron + Kora
3. **Renderer process considerations:**
   - If running in the renderer with `nodeIntegration: true`, `better-sqlite3` works directly
   - If running in a sandboxed renderer (recommended), need IPC bridge to main process
   - This is similar to the Tauri pattern but using Electron's IPC

4. **Optional: `@korajs/electron` package** — IPC bridge for sandboxed renderers
   - Main process: opens `better-sqlite3`, exposes IPC handlers
   - Renderer process: `ElectronSqliteAdapter` sends queries via IPC
   - Only needed for sandboxed renderers (recommended security practice)

### 2.3 Implementation

If `nodeIntegration: true` (simpler, less secure):
- No new package needed — `better-sqlite3` adapter already works
- Template + docs only

If sandboxed renderer (recommended):
- New `packages/electron/` with `ElectronSqliteAdapter`
- Preload script that exposes IPC bridge
- Main process handler that manages `better-sqlite3` connections
- Same pattern as Tauri: adapter ↔ IPC ↔ native SQLite

**Estimated scope:** ~2-3 sessions (template + docs + optional IPC bridge)

---

## Phase 3: React Native / Expo (Mobile)

**Goal:** Kora works in React Native apps with native SQLite and sync.

### 3.1 Architecture

```
React Native App
  └── @korajs/react-native
        └── Uses expo-sqlite or react-native-quick-sqlite
              └── Native SQLite (iOS/Android)
```

### 3.2 New Package: `@korajs/react-native`

```
packages/react-native/
  src/
    react-native-sqlite-adapter.ts   # StorageAdapter using expo-sqlite
    index.ts                          # Exports adapter
  package.json
    peerDependencies:
      expo-sqlite: "^14.0.0"         # Optional — Expo
      react-native-quick-sqlite: "*"  # Optional — bare RN
```

**Adapter implementation:**
- `ReactNativeSqliteAdapter` implements `StorageAdapter`
- Delegates to `expo-sqlite` (Expo) or `react-native-quick-sqlite` (bare RN)
- Synchronous API matches better-sqlite3 pattern (both are native SQLite)
- WAL mode, foreign keys, busy timeout — same pragmas as Tauri

### 3.3 Adapter Detection

Add to `adapter-resolver.ts`:

```typescript
// React Native environment
if (typeof navigator !== 'undefined' && navigator.product === 'ReactNative') {
  return 'react-native-sqlite'
}
```

### 3.4 React Hooks Compatibility

`@korajs/react` hooks (`useQuery`, `useMutation`, etc.) should work in React Native without changes — they use `useSyncExternalStore` which is available in React Native 18+.

**Potential issue:** `useSyncExternalStore` requires the React Native New Architecture (Fabric). Verify compatibility.

### 3.5 Considerations

- **No Web Workers** — React Native doesn't have Web Workers. SQLite runs on the JS thread (but native SQLite is fast enough — sub-ms for most queries)
- **Background sync** — React Native apps can be backgrounded. Need to handle:
  - Reconnection on foreground
  - Background fetch for sync (iOS Background App Refresh, Android WorkManager)
- **Storage location** — use app's documents directory, not tmp
- **Bundle size** — React Native already includes JSC/Hermes, so no WASM overhead concerns

### 3.6 CLI Template: `expo`

```
expo/
  app/
    index.tsx             # Expo Router entry
    (tabs)/
      index.tsx           # Main screen with Kora queries
  src/
    schema.ts
    auth.ts
  app.json                # Expo config
  package.json            # korajs + @korajs/react-native + expo-sqlite
```

### 3.7 Testing

- Use Expo's testing tools or Detox for E2E
- Verify: web template produces zero React Native code in bundle

**Estimated scope:** ~4-5 sessions (new adapter, testing on iOS/Android, template)

---

## Phase 4: Flutter (Future)

**Goal:** Kora works in Flutter apps via Dart FFI to native SQLite.

### 4.1 Architecture

This requires a different approach since Flutter doesn't use JavaScript:

```
Flutter App
  └── kora_flutter (Dart package)
        └── Uses sqflite or drift
              └── Native SQLite (iOS/Android/Desktop)
        └── Sync engine (Dart port or FFI to JS)
```

### 4.2 Options

**Option A: Dart-native implementation**
- Port core, store, merge, sync to Dart
- Highest performance, best DX for Flutter devs
- Significant effort (months of work)

**Option B: JavaScript bridge**
- Run Kora.js in a JS runtime embedded in the Flutter app (e.g., `flutter_js`)
- Bridge data via JSON over FFI
- Faster to ship, but adds latency and complexity

**Option C: Shared Rust core**
- Implement core operations, merge, and sync in Rust
- Use FFI from both TypeScript (via WASM/Tauri) and Dart (via FFI)
- Most architecturally sound long-term, but highest initial investment

**Recommendation:** Option A is the pragmatic choice if Flutter support is a priority. Option C is the "right" long-term answer if Kora expands to many non-JS platforms.

**Estimated scope:** Option A: ~3-4 months. Option C: ~6+ months.

---

## Phase 5: Capacitor / Ionic (Hybrid Mobile)

**Goal:** Kora works in Capacitor apps (web apps wrapped in native shells).

### 5.1 Architecture

Capacitor apps run web code in a WebView. Two approaches:

**Approach 1: Use existing web adapters (SQLite WASM + OPFS)**
- Works today with zero changes
- Performance is slightly worse than native SQLite
- OPFS may not be available in all WebView versions

**Approach 2: Native SQLite via Capacitor plugin**
- Use `@capacitor-community/sqlite`
- New `@korajs/capacitor` adapter
- Better performance and reliability

### 5.2 Implementation

```
packages/capacitor/
  src/
    capacitor-sqlite-adapter.ts   # StorageAdapter using @capacitor-community/sqlite
    index.ts
  package.json
    peerDependencies:
      @capacitor-community/sqlite: "^6.0.0"
```

**Detection:**
```typescript
if (typeof (window as any).Capacitor !== 'undefined') {
  return 'capacitor-sqlite'
}
```

**Estimated scope:** ~2 sessions (adapter is thin, most logic is in the Capacitor plugin)

---

## Cross-Platform Testing Strategy

### Test Matrix

| Platform | Adapter | Storage | Sync Transport | Test Method |
|----------|---------|---------|----------------|-------------|
| Web (Chrome) | sqlite-wasm | OPFS | WebSocket | Playwright |
| Web (Firefox) | sqlite-wasm | OPFS | WebSocket | Playwright |
| Web (Safari) | indexeddb | IndexedDB | WebSocket | Playwright |
| Tauri (macOS) | tauri-sqlite | Native SQLite | WebSocket | Tauri test driver |
| Tauri (Windows) | tauri-sqlite | Native SQLite | WebSocket | Tauri test driver |
| Tauri (Linux) | tauri-sqlite | Native SQLite | WebSocket | GitHub Actions |
| Electron | better-sqlite3 | Native SQLite | WebSocket | Spectron/Playwright |
| React Native (iOS) | react-native-sqlite | Native SQLite | WebSocket | Detox |
| React Native (Android) | react-native-sqlite | Native SQLite | WebSocket | Detox |
| Capacitor (iOS) | capacitor-sqlite | Native SQLite | WebSocket | Appium |
| Capacitor (Android) | capacitor-sqlite | Native SQLite | WebSocket | Appium |

### Shared Test Suite

Write platform-agnostic integration tests that verify:

1. **CRUD operations** — insert, query, update, delete
2. **Reactive queries** — mutations trigger subscription notifications
3. **Offline queue** — operations persist through app restart
4. **Sync convergence** — two clients converge after concurrent edits
5. **Schema migration** — upgrading schema version works

These tests should be runnable against ANY adapter. The adapter is injected, the test logic is shared:

```typescript
// tests/shared/crud.test.ts
export function crudTests(createAdapter: () => Promise<StorageAdapter>) {
  test('insert and query', async () => {
    const adapter = await createAdapter()
    // ...
  })
}
```

Each platform's test suite imports and runs the shared tests with its adapter.

---

## Bundle Size Budget

| Platform | Core Bundle | Platform Adapter | Total | Notes |
|----------|-------------|-----------------|-------|-------|
| Web | ~50KB gzip | ~15KB (WASM loader) | ~65KB | WASM binary loaded separately (~400KB) |
| Tauri | ~50KB gzip | ~5KB (IPC bridge) | ~55KB | No WASM, native SQLite |
| Electron | ~50KB gzip | ~3KB (direct) | ~53KB | No WASM, `better-sqlite3` is native |
| React Native | ~50KB gzip | ~5KB (bridge) | ~55KB | Native SQLite via expo-sqlite |
| Capacitor | ~50KB gzip | ~5KB (bridge) | ~55KB | Native SQLite via Capacitor plugin |

**Enforcement:** Add bundle size check to CI. Fail if any platform's adapter adds code to another platform's bundle.

---

## Priority & Timeline

| Phase | Platform | Priority | Reason |
|-------|----------|----------|--------|
| 1 | Tauri Desktop | **HIGH** | Already built, just needs polish + docs + template |
| 2 | Electron | **MEDIUM** | Large ecosystem, mostly works already |
| 3 | React Native | **MEDIUM** | Mobile is critical for offline-first |
| 4 | Flutter | **LOW** | Requires Dart port or Rust core — significant effort |
| 5 | Capacitor | **LOW** | Web adapters already work in Capacitor WebViews |

### Immediate Next Steps (Phase 1)

1. Publish `tauri-plugin-kora` to crates.io
2. Create Tauri CLI template
3. Write Tauri guide in docs
4. Update storage/adapter docs to mention Tauri
5. Add Tauri to the getting-started page
6. Test with KoraForms as a Tauri desktop app (validates the full flow)

---

## Open Questions

1. **Should the Tauri template include auto-updater setup?** Tauri has built-in auto-update support. Including it in the template would be a great DX win, but adds complexity.

2. **Should we build a shared Rust core (Phase 4, Option C)?** If Kora will eventually support Flutter, Swift, and Kotlin, a Rust core with FFI bindings is the right architecture. But it's a massive investment. Decide when Flutter demand is clear.

3. **React Native: Expo only or bare RN too?** Supporting both doubles the testing surface. Expo covers ~80% of RN developers. Consider Expo-only initially.

4. **Background sync on mobile?** iOS and Android have different background execution models. Do we handle this in the framework (with platform-specific background sync adapters) or leave it to the developer?

5. **Data location and encryption at rest?** Desktop and mobile apps have different security expectations. Should we provide built-in SQLite encryption (SQLCipher) as an option?

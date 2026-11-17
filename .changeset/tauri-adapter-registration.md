---
'korajs': patch
'@korajs/tauri': patch
'@korajs/cli': patch
---

Storage auto-detected inside Tauri now opens in a built app. `createApp` used to load `@korajs/tauri` through an import that bundlers cannot see, and a webview cannot resolve a bare package name, so it failed with "Failed to resolve module specifier '@korajs/tauri'". Importing `@korajs/tauri` now registers its adapter, and `createApp` uses that registration. The `tauri-react` template imports it in `src/main.tsx`. Without the import, the error says what to add. `korajs` now declares `@korajs/tauri` as an optional peer.

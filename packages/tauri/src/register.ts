import { TauriSqliteAdapter } from './tauri-sqlite-adapter'

/**
 * Where `createApp` looks for the native SQLite adapter when it detects Tauri. Importing
 * `@korajs/tauri` anywhere in the app's entry registers it: the adapter is then part of the
 * app's bundle, which a webview needs (it cannot resolve a bare `import('@korajs/tauri')`).
 */
export const TAURI_ADAPTER_REGISTRY_KEY = Symbol.for('korajs.storage.tauri-sqlite')
;(globalThis as unknown as Record<symbol, unknown>)[TAURI_ADAPTER_REGISTRY_KEY] = TauriSqliteAdapter

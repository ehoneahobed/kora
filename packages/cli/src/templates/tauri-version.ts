/**
 * Version of `@korajs/tauri` that the `tauri-react` template installs.
 *
 * `@korajs/tauri` is versioned on its own line (outside the linked `@korajs/*` group), so the
 * template cannot reuse `koraVersion`: `@korajs/tauri@<koraVersion>` does not exist on npm and
 * the scaffolded install would fail. `scripts/release/bump-beta.mjs` rewrites this constant with
 * the package's new version, and a unit test keeps it equal to `packages/tauri/package.json`.
 */
export const KORA_TAURI_TEMPLATE_VERSION = '0.4.3-beta.12'

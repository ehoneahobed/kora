---
"@korajs/core": patch
"@korajs/store": patch
"@korajs/merge": patch
"@korajs/sync": patch
"@korajs/server": patch
"@korajs/react": patch
"@korajs/vue": patch
"@korajs/svelte": patch
"@korajs/tauri": patch
"@korajs/auth": patch
"@korajs/devtools": patch
"@korajs/cli": patch
"@korajs/test": patch
"korajs": patch
---

Package export hygiene and auth secret-handling hardening.

- Every published package now exposes `./package.json` in its `exports` map. Previously `require.resolve('@korajs/core/package.json')` (and the same for every other package) failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`, which breaks tooling that reads a package's manifest or version at runtime.
- `createKoraAuthServer` now warns loudly when it falls back to an ephemeral random JWT secret outside production, so a deployment that never set `NODE_ENV=production` no longer silently regenerates its signing key on every restart (which invalidates all existing tokens) without any signal.
- `KORA_AUTH_SECRET` set to an empty or whitespace-only string is now treated as unset rather than as an invalid secret, so it triggers the intended dev fallback / production guard instead of crashing `TokenManager` with a "secret too short" error.

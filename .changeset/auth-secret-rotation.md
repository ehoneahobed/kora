---
"@korajs/auth": patch
"@korajs/cli": patch
---

Change the sign-in secret without signing anyone out. `KORA_AUTH_SECRET` signs and the comma-separated secrets in `KORA_AUTH_SECRET_PREVIOUS` are still accepted; sessions move to the new secret at their next refresh. `createKoraAuthServer` reads both when `jwtSecret` is left out, and `authSecretFromEnv()` (from `@korajs/auth/server`) returns the same for apps that pass `jwtSecret`. Templates use it and list `KORA_AUTH_SECRET_PREVIOUS` in `.env.example`.

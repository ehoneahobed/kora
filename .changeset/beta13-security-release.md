---
"korajs": minor
"@korajs/auth": minor
"@korajs/cli": minor
"@korajs/core": minor
"@korajs/devtools": minor
"@korajs/merge": minor
"@korajs/react": minor
"@korajs/server": minor
"@korajs/store": minor
"@korajs/svelte": minor
"@korajs/sync": minor
"@korajs/test": minor
"@korajs/vue": minor
"create-kora-app": patch
"@korajs/tauri": patch
---

1.0.0-beta.13: the security, data-safety and convergence release (breaking). The sync server is
the trust boundary (authenticated handshake first, server-granted scopes, verified operation ids,
per-user node ids, tenant-isolated side channels); no write is silently lost (durable sequenced
writes, gap-free delivery, quarantine instead of drops); every replica computes records with one
deterministic per-field CRDT fold (protocol v2); end-to-end encryption works across a user's
devices; records, inputs and queries are typed from the schema; scaffolded apps open offline.
Upgrade servers first, then clients. Release notes: docs/releases/v1.0.0-beta.13.md; upgrade
guide: docs/guide/upgrading-to-beta13.md; security advisory: docs/releases/security-advisory-beta13.md.

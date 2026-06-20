# Kora Full-Stack Example

Reference application that exercises the production Kora.js stack end-to-end. Use it to manually explore the framework or run automated smoke checks before a release.

## Package coverage

| Package | Exercised by |
|---------|----------------|
| `korajs` | `createApp`, transactions, sequences, backup, replay, audit export |
| `@korajs/core` | Schema, relations, operations |
| `@korajs/store` | SQLite WASM (browser) + native SQLite (verify script) |
| `@korajs/merge` | Multi-device convergence after concurrent writes |
| `@korajs/sync` | Client sync engine + WebSocket transport |
| `@korajs/server` | `server.ts` sync server (SQLite or Postgres) |
| `@korajs/react` | `KoraProvider`, `useQuery`, `useMutation`, `useSyncStatus` |
| `@korajs/auth` | Optional OAuth when `KORA_AUTH_SECRET` is set |
| `@korajs/devtools` | Enabled in dev (`Ctrl+Shift+K`) |
| `@korajs/cli` | `kora dev`, migrations, code generation |
| `@korajs/test` | `pnpm verify` convergence harness |

Vue, Svelte, and Tauri bindings ship as separate CLI templates; this example focuses on the React + sync path.

## Quick start

From the monorepo root:

```bash
pnpm install
pnpm dev:full-stack
```

Or from this directory:

```bash
pnpm dev
```

- **App:** http://localhost:5173
- **Sync server:** ws://localhost:3001/kora-sync
- **DevTools:** `Ctrl+Shift+K` in the browser

Copy `.env.example` to `.env` and set auth variables to exercise `@korajs/auth`.

## Automated verification

Runs local CRUD, sequences, transactions, backup/replay/audit, cascade delete, and two-device sync convergence:

```bash
pnpm verify:full-stack
```

## Manual checklist

1. Add todos while offline (disable network in DevTools) — they persist after refresh.
2. Open a second browser profile/tab with the same origin — changes converge after reconnect.
3. Toggle sync status badge — pending count updates while offline.
4. Open DevTools panel — operation log and sync timeline populate.
5. Set `KORA_AUTH_SECRET` — sign-in flow and scoped sync activate.

## Schema

- **projects** — parent records
- **todos** — tasks with optional `projectId`
- **Relation** — cascade delete removes todos when a project is deleted

## Production

```bash
pnpm build
pnpm start
```

Set `DATABASE_URL` for Postgres-backed sync in production deployments.

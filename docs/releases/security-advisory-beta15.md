---
title: "Security advisory: Kora.js 1.0.0-beta.14 and earlier (fixed in 1.0.0-beta.15)"
---

# Security advisory: Kora.js 1.0.0-beta.14 and earlier

> **Draft. Not published.** GitHub advisory ids and CVSS scores are assigned when this is
> published with the 1.0.0-beta.15 release. Each item below was checked against the published
> `v1.0.0-beta.14` source. Fixes to features that are new in beta.15 (access rules,
> `@korajs/spaces`, the read-through endpoint) are not listed: no released version had them.

**Affected:** the packages named per item, `<= 1.0.0-beta.14` (every published version that has the
feature) · **Patched:** `1.0.0-beta.15` · **GitHub advisory:** `GHSA-xxxx-xxxx-xxxx`
(**placeholder**, assigned at publish; replace it here and in the release notes) · **CVSS:**
**placeholder**, assigned at publish

## Patches

Upgrade every `korajs` and `@korajs/*` package to `1.0.0-beta.15`, sync servers first. Desktop
apps also rebuild with the updated Tauri plugin. See the
[upgrade guide](../guide/upgrading-to-beta15.md).

```bash
npx kora upgrade --to 1.0.0-beta.15
```

## Authorization

- **`AdminApi` read methods skipped the admin check** (`@korajs/auth`). `listUsers`,
  `getUserSessions` and `getStats` did not check that the caller was an admin, so whoever could
  call them received every user's email, sessions or counts. Every method now takes the acting
  admin's id first and checks it with `isAdmin`, and each call is audited. Also,
  `deleteUser` and `revokeUserSessions` silently left a user's tokens valid when no revocation
  store was configured. They now refuse with `ADMIN_REVOCATION_UNAVAILABLE` before deleting
  anything. (#278)
- **An org admin could demote or remove another admin** (`@korajs/auth`). Only the owner can now
  change or remove an admin, matching the rule for adding one. (#253)
- **TOTP checks were not atomic** (`@korajs/auth`). With a database-backed `TotpStore`, two
  requests with the same code both signed in, one recovery code worked twice, and parallel wrong
  guesses were counted once, which weakened the lockout. Every write is now conditional on a
  revision (`TotpStore.saveIf`). (#251)
- **OAuth auto-linking trusted an unverified local address** (`@korajs/auth`, only with
  `oauth.autoLinkVerifiedEmail: true`, which is off by default). An OAuth sign-in whose provider
  verified the email was linked to an existing account holding that email even when that account
  had never verified it, so whoever registered someone else's address first was linked to the
  owner's provider identity. Both sides must now have verified the address; otherwise the sign-in
  is answered `409`. **Action:** existing password accounts have not verified their address; turn
  on `emailVerification` so they can. (#36)
- **Operational tokens were compared with `===`** (`@korajs/server`). The admin, metrics and backup
  tokens (and the insights token new in beta.15) are now compared in constant time. (#303)

## Network and denial of service

- **Webhook delivery resolved the host twice** (`@korajs/auth`). The address check and the
  request each resolved DNS, so a rebinding hostname could pass the check and then reach a private
  address. Delivery now connects to the address it checked, and `::/96` and NAT64 addresses
  embedding a private IPv4 are refused. (#291)
- **Unbounded work per session or request** (`@korajs/server`):
  - each session's inbound message queue is bounded (`INBOUND_QUEUE_FULL`) (#252);
  - handshake `syncQueries` are validated and capped (`maxSyncQueries`), and their deduplication
    is no longer quadratic (#241, #245);
  - custom route bodies get a deadline (`408`) and an in-flight cap (`503`) (#298);
  - live rich-text relays are limited per session by rate and size (#268, #277);
  - the blob access index is capped and evicts the least recently used entries (#297).
- **Process crash and bad restores** (`@korajs/server`). A malformed `Host` header on a WebSocket
  upgrade crashed the process. A truncated backup was restored in replace mode, emptying the store
  and reporting success. It is now refused (`BACKUP_CHECKSUM_MISMATCH`). (#235)

## Data integrity

- **A Postgres backup could claim operations it did not contain** (`@korajs/server`). The version
  vector was read after the rows, so an operation committed in between was claimed but missing.
  After a replace restore, that device never re-sent it, and it was lost. (#259)
- **A Tauri write could be rolled back by someone else's transaction** (`@korajs/tauri`). A
  standalone write sent while a transaction was open ran inside it, so a ROLLBACK lost it. (#247)

## Desktop (Tauri) and scaffolding

- **Every scaffolded Tauri app shared one identity** (`@korajs/cli`, `create-kora-app`). All
  `tauri-react` apps used the identifier `com.kora.app`. Tauri keys an app's data folder on it, so
  different apps on one machine opened the same database and overwrote each other's data. New apps
  get their own identifier, and `kora doctor` warns about an app still on `com.kora.app`. **Action:
  existing apps should choose a unique identifier.** It decides where data lives, so plan the move
  before users have data under the old one. (#262)
- **The Tauri plugin opened any path** (`@korajs/tauri`). Its `open` command accepted a parent
  (`..`) or absolute path, and connections allowed `ATTACH` and `VACUUM INTO`, so a compromised
  webview could read or write database files outside the app's data directory. (#280)
- **New apps had no `.gitignore`** (`@korajs/cli`). `.env`, which holds `KORA_AUTH_SECRET`, and
  the local databases could be committed. **Action: check existing repositories for a committed
  `.env`, and rotate the secret if one is there** (`KORA_AUTH_SECRET_PREVIOUS` lets sessions
  survive the rotation). (#264)
- **Lightsail deploys ran with sign-in off** (`@korajs/cli`). `kora deploy --platform aws-lightsail`
  forwarded `AUTH_SECRET`, but the templates read `KORA_AUTH_SECRET`. **Action: redeploy Lightsail
  apps with beta.15.** (#243)
- **RBAC read-only grants synced nothing** (`@korajs/auth`). A read-only role added a `__readonly`
  key that the server treated as a record filter, so viewers received no records, and their writes
  were refused only by accident. Grants are now directional (`SyncGrant`). (#236)

## Also fixed, not confirmed line by line against beta.14

These paths exist in beta.14, and their changesets describe the defect as present before the fix.
They were not each reproduced against the beta.14 source:

- `trustProxy: 0`, a negative count or `[]` silently disabled the setting (#282);
- binary values corrupted through Tauri, which affected rich text (#240);
- a replace-mode restore could drop unsynced writes on a crash (#250);
- rebase, rotation and re-author could leave old stamps in fold state on a crash (#260);
- after a clock rebase, the next write named a deleted causal dependency (#306);
- a service-worker update could interrupt a committing write (#215);
- devices could not recover from every server restore (#192);
- on shared browsers, accounts authored under one device id;
- multi-tab transaction isolation and IndexedDB snapshot ordering.

## Workarounds

Upgrading is the fix. Until then:
- expose `AdminApi` only behind your own admin check;
- keep webhook targets to hosts you control;
- put the server behind a proxy that limits request bodies and connections;
- give each Tauri app a unique identifier by hand.

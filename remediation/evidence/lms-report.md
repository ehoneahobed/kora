# Framework Recommendations for KoraJS

**From:** Bozoma Innovation Hub (LMS team)
**To:** KoraJS framework maintainers
**Date:** 2026-10-01
**Kora version:** 1.0.0-beta.12
**Context:** We ship a learning platform to users in Ghana on low-cost Android devices with intermittent connectivity. Over several months of production use, we have accumulated patches across four Kora packages (`@korajs/auth`, `@korajs/store`, `@korajs/sync`, `@korajs/server`) to fix issues that affect any offline-first Kora app — not just ours. This report documents each fix, explains why it belongs in the framework, and describes how it would benefit other Kora applications like church management systems, store POS, forms, and field tools.

We carry four patch files totalling ~600 lines of diff. We would much prefer these to live upstream.

---

# Part A — Auth: Offline Session Resilience (`@korajs/auth`)

## 1. `performRefresh()` must distinguish network errors from auth errors

### The problem

`performRefresh()` treats every exception identically:

```js
// @korajs/auth — dist/index.js, line 538
async performRefresh(refreshToken) {
  try {
    const response = await this.request("/auth/refresh", { ... });
    await this.storage.setTokens(response.accessToken, response.refreshToken);
    return response.accessToken;
  } catch {           // ← catches ALL errors uniformly
    await this.storage.clear();                 // destroys both tokens
    this.setState("unauthenticated", null);     // kicks user to login
    return null;
  }
}
```

The `request()` method already classifies errors with distinct codes:

| Situation | Error code | Meaning |
|---|---|---|
| `fetch()` itself throws (offline, DNS, timeout) | `AUTH_NETWORK_ERROR` | Server unreachable — says nothing about token validity |
| Server returns 401/403 | `AUTH_SERVER_ERROR` (status 401/403) | Refresh token is revoked or invalid |
| Server returns other non-2xx | `AUTH_SERVER_ERROR` (other status) | Server-side problem |

But `performRefresh()` discards the error object (`catch {`), so it cannot tell the difference. A single Wi-Fi dropout permanently destroys a 90-day refresh token.

### Recommended fix

```js
async performRefresh(refreshToken) {
  try {
    const response = await this.request("/auth/refresh", { ... });
    await this.storage.setTokens(response.accessToken, response.refreshToken);
    return response.accessToken;
  } catch (err) {
    if (err?.code === "AUTH_NETWORK_ERROR") {
      return null;   // preserve tokens for retry when back online
    }
    await this.storage.clear();
    this.setState("unauthenticated", null);
    return null;
  }
}
```

Non-breaking. Online behaviour is identical. ~5 lines changed.

### Impact across app types

- **Church management:** Pastor opens the app on Sunday, building Wi-Fi is down. Currently: locked out, tokens destroyed.
- **Store POS:** Clerk's phone loses signal mid-shift. Currently: the app clears tokens and shows a login screen mid-transaction.
- **Forms / field surveys:** Enumerator is in a rural area with no signal for hours. Currently: every background refresh attempt destroys the session.

---

## 2. `initialize()` should restore a degraded session when offline

### The problem

When the app cold-starts offline, `initialize()` follows this path:

```
1. Read access token  → expired (15-min TTL)
2. Read refresh token → valid (90-day TTL)
3. Call refreshAccessToken() → fails (no network)
4. await this.storage.clear()       ← destroys the refresh token
5. this.setState("unauthenticated") ← kicks user to login
```

Even with the `performRefresh()` fix above, `initialize()` has its own independent `clear()` call that still destroys everything.

But the framework already has all the machinery to handle this gracefully. `restoreSession()` is designed to work offline — when the profile fetch fails, it extracts the userId from the JWT payload and builds a minimal user object. `initialize()` just never calls it on the offline path.

### Recommended fix

```js
async initialize() {
  // ... (existing token loading + non-expired fast path) ...

  try {
    const newAccessToken = await this.refreshAccessToken(refreshToken);
    if (newAccessToken) {
      await this.restoreSession(newAccessToken);
      return;
    }
  } catch {}

  // NEW: offline with valid refresh token → degrade gracefully
  if (!this.isOnline() && !isTokenExpired(refreshToken)) {
    await this.restoreSession(accessToken);  // uses expired JWT for userId
    return;
  }

  await this.storage.clear();
  this.setState("unauthenticated", null);
}
```

### Design note: "authenticated" with an expired access token

This is safe because:

- The access token is only used for server communication. When offline, there is no server communication.
- The local SQLite store is gated by userId namespace, correctly extracted from the expired token.
- When connectivity returns, `getAccessToken()` will detect the expired access token, call `refreshAccessToken()` with the preserved refresh token, and obtain a fresh pair seamlessly.
- `restoreSession()` already handles this case — no new code path introduced.

Any Kora app that loads from a service worker or is installed as a PWA can now cold-start offline and show locally cached data without any app-level workaround.

---

## 3. Offer a resilient token storage adapter (or make it the default)

### The problem

The default `TokenStore` uses `localStorage` as its only persistence layer. Mobile browsers (especially Chrome on Android and Safari on iOS) can clear `localStorage` under storage pressure, silently destroying the session even though the OPFS database and IndexedDB device keys survive.

### Recommendation

Ship a built-in `ResilientTokenStore` that writes tokens to **both** `localStorage` (fast synchronous reads) and **IndexedDB** (survives eviction):

```ts
createKoraAuth({
  serverUrl: '...',
  storage: 'resilient',   // or make this the default
})
```

| Method | Online | Offline |
|---|---|---|
| `getAccessToken()` | Read localStorage; if missing, restore from IndexedDB | Same |
| `getRefreshToken()` | Same | Same |
| `setTokens()` | Write to both localStorage and IndexedDB | Same |
| `clear()` | Clear both stores | Clear localStorage only; preserve IndexedDB backup |

Kora already uses IndexedDB for device keys (`IndexedDBDeviceKeyStore`), so this introduces no new browser API dependency. Since the backup is invisible to consumers, there is no breaking change in making this the default.

---

## 4. Request `navigator.storage.persist()` in the framework

### The problem

Without `navigator.storage.persist()`, all browser storage (localStorage, IndexedDB, OPFS, Cache API) is "best-effort". Under storage pressure, the browser can evict any or all of it — including the SQLite database Kora uses for offline data.

Kora's `StorageSafetyGate` already **detects** when storage falls back to non-durable mode, but by that point data may already be lost. The missing piece is **requesting** durable storage before the damage occurs.

### Recommendation

Call `navigator.storage.persist()` during Kora app initialization (e.g., in `createApp()` or `AuthBoundKoraProvider` mount):

```js
if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
  navigator.storage.persist().then((granted) => {
    if (!granted) console.warn('[kora] Persistent storage not granted');
  });
}
```

This protects the entire storage stack — OPFS, IndexedDB, and localStorage — from eviction. One line, idempotent, no side effects if the browser declines. Every Kora app benefits since every Kora app uses OPFS.

---

# Part B — Store: OPFS SAH Pool Resilience (`@korajs/store`)

## 5. OPFS pool install should retry on lock conflicts

### The problem

`installOpfsPool()` attempts to install the OPFS SAH pool VFS exactly once. If a lock conflict occurs (common when the user has multiple tabs open, or on Android Chrome where a background service worker holds a lock), the install fails and Kora falls back to an in-memory database — losing all offline data.

### Recommended fix

Retry up to 3 times with a 2-second delay on `lock-conflict` errors. The patch also increases `initialCapacity` from the default 6 to 32 slots and calls `reserveMinimumCapacity()` to expand existing pools that were created with the old smaller default.

```js
var OPFS_LOCK_RETRY_ATTEMPTS = 3;
var OPFS_LOCK_RETRY_DELAY_MS = 2000;
var OPFS_MIN_CAPACITY = 32;

async function installOpfsPool(sqlite3) {
  for (let attempt = 0; attempt <= OPFS_LOCK_RETRY_ATTEMPTS; attempt++) {
    try {
      const pool = await withTimeout(
        sqlite3.installOpfsSAHPoolVfs({
          name: OPFS_POOL_NAME,
          initialCapacity: OPFS_MIN_CAPACITY,
        }),
        OPFS_INIT_TIMEOUT_MS,
        "OPFS VFS install"
      );
      if (pool?.reserveMinimumCapacity) {
        await pool.reserveMinimumCapacity(OPFS_MIN_CAPACITY);
      }
      return pool;
    } catch (error) {
      const kind = classifyOpfsFailure(error);
      if (kind === "lock-conflict" && attempt < OPFS_LOCK_RETRY_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, OPFS_LOCK_RETRY_DELAY_MS));
        continue;
      }
      opfsFallbackReason = kind;
      return null;
    }
  }
  return null;
}
```

### Impact

Without this, any Kora app on a phone where the user opens a second tab (or the PWA restarts with a lingering service worker) will silently lose all offline data for that session. Church apps on shared tablets are especially vulnerable — two people opening the app in quick succession triggers a lock conflict.

---

## 6. Auto-evict stale OPFS files when the SAH pool is full

### The problem

When a Kora app rotates database generations (schema migration, impersonation, scope changes), the old `kora-db-gN` files and their WAL companions remain in the OPFS SAH pool. The default pool capacity is 6 slots. After a few generation bumps, `new pool.OpfsSAHPoolDb(filename)` throws "SAH pool is full" — a fatal error that requires the user to manually clear site data.

### Recommended fix

Wrap the database open in a recovery function that, on "SAH pool is full", unlinks files that do not belong to the current database and retries:

```js
async function openOpfsDatabase(pool, filename) {
  try {
    return new pool.OpfsSAHPoolDb(filename);
  } catch (error) {
    if (!/SAH pool is full/i.test(error?.message)) throw error;
    // Evict orphaned generation / WAL files
    const names = pool.getFileNames?.() ?? [];
    for (const name of names) {
      if (pathMatchesDb(name, filename)) continue;
      try { pool.unlink(name); } catch {}
    }
    if (pool.reserveMinimumCapacity) {
      await pool.reserveMinimumCapacity(OPFS_MIN_CAPACITY);
    }
    return new pool.OpfsSAHPoolDb(filename);
  }
}
```

### Impact

Without this, any Kora app that bumps database generations (which the framework encourages for schema migrations) will eventually hit a "SAH pool is full" error and require manual site data clearing. Users on phones will not know how to do this. Self-healing is essential.

---

## 7. Follower RPC liveness probe should repeat, not fire once

### The problem

The IndexedDB adapter's follower tab sends a single liveness probe via `setTimeout` to detect a dead leader. If that one probe misses the window (e.g., the leader dies just after the probe succeeds), the follower waits for the full RPC timeout (120 seconds) before failing — the user sees the app frozen for 2 minutes.

### Recommended fix

Change the one-shot `setTimeout` probe to a repeating `setInterval`:

```js
const runProbe = () => {
  void this.pingLeader(this.livenessProbeMs).then((alive) => {
    if (!alive && this.pending.has(requestId)) {
      settle(() => reject(new NoLeaderError(...)));
    }
  });
};
probeInterval = setInterval(runProbe, this.livenessProbeMs + 1000);
setTimeout(runProbe, this.livenessProbeMs);  // first probe at original timing
```

### Impact

Any multi-tab Kora app (common — users open links, duplicating tabs) benefits from faster dead-leader detection. A store POS with multiple checkout terminals using the same origin would otherwise stall for 2 minutes when the leader tab closes.

---

# Part C — Sync: Scope Filtering Correctness (`@korajs/sync`)

## 8. `buildSnapshot()` must include `op.recordId` as `id`

### The problem

Operations store the record's ID in `op.recordId`, not in `op.data`. When scope predicates filter by `id` (e.g., `{ id: { $in: [...] } }`), the snapshot built by `buildSnapshot()` does not contain an `id` field, causing false scope mismatches. Operations that should be visible to the client are silently dropped.

### Recommended fix

```js
function buildSnapshot(op, fullRecord) {
  const previous = asRecord(op.previousData);
  const next = asRecord(op.data);
  if (!previous && !next && !fullRecord) return null;
  const merged = {
    ...fullRecord ?? {},
    ...previous ?? {},
    ...next ?? {},
  };
  if (!('id' in merged) && op.recordId) {
    merged.id = op.recordId;
  }
  return merged;
}
```

### Impact

Any Kora app using id-based scope predicates (common for per-user or per-organisation data filtering) will silently lose data without this fix. This is a correctness bug, not a performance issue.

---

## 9. Skip client-side scope filtering when directional scopes are active

### The problem

When the server supplies separate downlink and uplink scopes (`hasDirectionalScopes === true`), the client-side `matchesScopeAndSubsets()` re-filters received operations with incomplete data. For example, an update operation `{ status: 'published' }` would fail a scope predicate on `courseId` because `courseId` is absent from the operation snapshot — it was not modified and is not included.

The server already performed scope filtering with full record data (via `lookupRecordFields`). The client re-filtering is redundant and incorrect because the client lacks the full record context.

### Recommended fix

```js
matchesScopeAndSubsets(op, fullRecord) {
  // Server already checked visibility with full record data.
  if (this.hasDirectionalScopes) return true;
  if (!operationMatchesScope(op, this.activeUplinkScope, fullRecord)) {
    return false;
  }
  return operationMatchesQuerySubsets(op, this.getActiveQuerySubsets(), fullRecord);
}
```

### Impact

Any Kora app using directional scopes (the recommended pattern for RBAC) will experience "missing data" symptoms where operations arrive from the server but are incorrectly filtered out by the client. This manifests as records that appear on one device but not another, or records that disappear after a reconnect — extremely confusing for users and developers alike.

---

# Part D — Server: Delivery Performance & Connection Health (`@korajs/server`)

## 10. Parallel and batched Postgres backfill

### The problem

`backfillAllCollections()` processes collections sequentially, and `backfillCollection()` inserts one record at a time. For a schema with 27 collections and thousands of operations, a cold-start backfill takes minutes.

### Recommended fix

- Process collections in parallel (concurrency 4).
- Batch individual upserts into multi-row `INSERT ... ON CONFLICT` statements (batch size 500) inside a single transaction per collection.

### Impact

Any Kora app deployed on Postgres (the production recommendation) benefits from dramatically faster server starts and migration backfills. Our app went from ~90 seconds to ~8 seconds for a 27-collection backfill. This matters for zero-downtime deploys and container restarts.

---

## 11. Delivery stream: preload scope records and use deny-set

### The problem

`sendDeliveryStream()` calls `lookupRecordFields()` per operation to check scope visibility. Each call is a separate Postgres query. For a client's first sync with thousands of operations, this generates thousands of individual queries — often taking 5+ minutes on a modestly sized database.

### Recommended fix

Three optimisations, all in `sendDeliveryStream()`:

1. **Preload scope records:** Before scanning, bulk-load all records for scoped collections into an in-memory `Map`. Replace per-operation queries with `Map.get()`.

2. **Deny-set for `__none__` scopes:** Collections scoped to `__none__` (meaning "this user has no access") can be skipped entirely without examining each operation.

3. **Skip retractions on first sync:** When `fromDeliverySeq === 0`, there is no prior client state to retract from. Computing retractions is pure waste.

4. **Larger scan chunks:** Increase from `batchSize * 5` to `batchSize * 20` to reduce the number of database round-trips.

### Impact

First-sync delivery time for our 27-collection schema dropped from ~5 minutes to ~30 seconds. Any Kora app with RBAC scopes (i.e., every multi-user app) will see similar improvements. This is the difference between "usable on 3G" and "times out on 3G."

---

## 12. WebSocket ping/pong keepalive

### The problem

The Kora dev/production server does not implement WebSocket keepalive. Dead connections (mobile phone sleeps, network switches, NAT timeout) linger indefinitely. The server continues scanning delivery streams for ghost clients, wasting CPU and database connections. The client does not learn the connection is dead until it tries to send, which may be minutes later.

### Recommended fix

Add a 30-second ping/pong interval to the WebSocket upgrade handler:

```js
wss.handleUpgrade(req, socket, head, (ws) => {
  let isAlive = true;
  ws.on("pong", () => { isAlive = true; });
  const pingTimer = setInterval(() => {
    if (!isAlive) { ws.terminate(); return; }
    isAlive = false;
    ws.ping();
  }, 30_000);
  ws.on("close", () => clearInterval(pingTimer));
  const transport = new WsServerTransport(ws);
  syncServer.handleConnection(transport);
});
```

### Impact

Without keepalive, every Kora server accumulates dead sessions. On a church management app with 50 phones in a room, half the congregation's phones going to sleep creates 25 ghost sessions that the server continues processing. Keepalive reclaims them in 30 seconds.

---

## 13. Cache-Control headers for hashed assets

### The problem

The built-in static file server sends no `Cache-Control` header. Vite produces content-hashed filenames in `/assets/` (e.g., `index-drBNyszg.js`), but browsers re-validate every request because no caching directive is set. On slow connections, this adds seconds of latency to every page load.

### Recommended fix

```js
const isHashed = filePath.includes("/assets/");
const cacheControl = isHashed
  ? "public, max-age=31536000, immutable"
  : "no-cache";
res.writeHead(200, { "Content-Type": contentType, "Cache-Control": cacheControl });
```

### Impact

Every Kora app using the built-in server gets instant repeat loads for static assets. On 2G/3G connections (common in our deployment), this is the difference between 1-second and 10-second page loads after the first visit.

---

# Summary

| # | Package | Change | Breaking? | Effort | Category |
|---|---|---|---|---|---|
| 1 | `@korajs/auth` | `performRefresh()`: preserve tokens on network error | No | ~5 lines | Correctness |
| 2 | `@korajs/auth` | `initialize()`: restore degraded session offline | No | ~5 lines | Correctness |
| 3 | `@korajs/auth` | Ship resilient token storage adapter | No | ~80 lines | Reliability |
| 4 | `@korajs/auth` | Call `navigator.storage.persist()` | No | ~5 lines | Reliability |
| 5 | `@korajs/store` | OPFS pool: retry on lock conflict + expand capacity | No | ~30 lines | Reliability |
| 6 | `@korajs/store` | OPFS pool: auto-evict stale files on pool full | No | ~25 lines | Self-healing |
| 7 | `@korajs/store` | Follower RPC: repeat liveness probe | No | ~10 lines | Reliability |
| 8 | `@korajs/sync` | `buildSnapshot()`: include `op.recordId` as `id` | No | ~3 lines | Correctness |
| 9 | `@korajs/sync` | Skip client-side scope filter with directional scopes | No | ~5 lines | Correctness |
| 10 | `@korajs/server` | Parallel + batched Postgres backfill | No | ~60 lines | Performance |
| 11 | `@korajs/server` | Delivery stream preloading + deny-set + skip first-sync retractions | No | ~50 lines | Performance |
| 12 | `@korajs/server` | WebSocket ping/pong keepalive | No | ~10 lines | Reliability |
| 13 | `@korajs/server` | Cache-Control for hashed assets | No | ~5 lines | Performance |

All 13 changes are non-breaking and backward-compatible. They span four packages but share a common theme: making Kora actually work as advertised for offline-first applications on real-world networks.

**Priority tiers:**

- **Critical (data loss / session loss):** #1, #2, #8, #9 — these are correctness bugs that silently drop data or destroy sessions.
- **High (reliability):** #3, #4, #5, #6, #7, #12 — these prevent recoverable failures from becoming unrecoverable.
- **Important (performance):** #10, #11, #13 — these make the difference between "works on 3G" and "times out on 3G."

Our patch files for all four packages are in the `patches/` directory of our repository. We are happy to contribute PRs.

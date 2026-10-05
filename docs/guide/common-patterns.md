---
title: Common Patterns
description: "Production patterns for Kora.js: pagination, derived state, optimistic UI, soft deletes, and recipes beyond basic offline-first CRUD."
---

# Common Patterns

Real-world apps go beyond basic CRUD. This guide covers patterns you'll encounter when building production applications with Kora.

<!-- docs-check-prelude
import { createApp, defineSchema, op, t } from 'korajs'
import { useCollection, useMutation, useQuery, useSyncStatus } from '@korajs/react'
import { useState } from 'react'
const schema = defineSchema({
  version: 1,
  collections: {
    forms: { fields: { title: t.string(), ownerId: t.string(), slug: t.string().default(''), status: t.string().default('draft') } },
    responses: { fields: { formId: t.string(), data: t.string(), submittedAt: t.timestamp().auto() } },
    orders: { fields: { status: t.string(), total: t.number(), orderNumber: t.string().optional() } },
    lineItems: { fields: { orderId: t.string(), product: t.string(), price: t.number(), qty: t.number() } },
    inventory: { fields: { reserved: t.boolean().default(false), stock: t.number().merge('counter') } },
    todos: { fields: { title: t.string(), completed: t.boolean().default(false), createdAt: t.timestamp().auto() } },
  },
})
const app = createApp({ schema })
declare const userId: string
declare const formId: string
declare const orderId: string
declare const productId: string
declare const cartItems: { name: string; price: number; qty: number }[]
declare function showToast(message: string): void
declare function FormCard(props: { form: { id: string; title: string }; responseCount: number }): JSX.Element
declare function TodoItem(props: { todo: { id: string; title: string } }): JSX.Element
declare function ResponseCard(props: { response: { id: string } }): JSX.Element
import { createKoraAuth } from '@korajs/auth'
import type { UserStore } from '@korajs/auth/server'
import type { ServerStore } from '@korajs/server'
declare const userStore: UserStore
declare const store: ServerStore
declare const syncUrl: string
const authClient = createKoraAuth({ serverUrl: 'https://api.example.com' })
declare function verifyToken(token: string): Promise<{ id: string; orgId: string } | null>
-->

---

## Anonymous / Public Data Access

Many apps need both authenticated and public access. For example:
- A **form builder** where signed-in users create forms, but anyone can submit responses
- A **survey tool** where respondents don't need accounts
- A **feedback widget** embedded on any website

Kora supports this with `MixedAuthProvider` on the server and anonymous sync on the client. Public users get full offline-first capabilities: their data saves locally and syncs when connected.

### Server Setup

Use `MixedAuthProvider` to accept both authenticated and anonymous connections. Anonymous users are restricted to specific collections via scopes:

```typescript
import { KoraSyncServer, MixedAuthProvider } from '@korajs/server'
import { createKoraAuthServer } from '@korajs/auth/server'

const authServer = createKoraAuthServer({ userStore, jwtSecret: process.env.KORA_AUTH_SECRET })

const auth = new MixedAuthProvider({
  primary: authServer.auth,
  anonymousScopes: {
    // Anonymous users can only sync the 'responses' collection
    responses: {},
  },
})

const syncServer = new KoraSyncServer({ store, auth })
```

### Client Setup

A signed-out device connects without a token and gets the anonymous grant. With
`createKoraAuthSync`, opt in with `anonymous: 'allow'` (the default suspends sync until sign-in):

```typescript
import { createKoraAuthSync } from '@korajs/auth'

const publicApp = createApp({
  schema,
  sync: {
    url: syncUrl,
    authClient: createKoraAuthSync({ authClient, schema, anonymous: 'allow' }),
    autoConnect: true,
  },
})
```

### How It Works

1. Authenticated user connects → `MixedAuthProvider` validates their token via the primary provider → they get full access (or scoped access based on their role).
2. Anonymous user connects without a token → `MixedAuthProvider` creates a scoped anonymous context → they can only sync collections listed in `anonymousScopes`. The device receives a secret node token at its first handshake and must present it to reconnect with the same node id.
3. Both users get full offline-first capabilities. Their data saves locally and syncs when connected.
4. The grant restricts which collections anonymous users can read and write. An operation outside it is refused, and the device reports it with `sync:operation-rejected`; it is never silently dropped.

::: tip
Anonymous users' operations are synced to the server and visible to authenticated users who have access to those collections. This means a form owner can see all responses, even those submitted anonymously.
:::

---

## Derived Data (Don't Store Counters)

A common mistake is storing aggregated values (counts, sums, averages) as fields on a record, then trying to keep them in sync. This breaks in offline-first apps because:

1. **Sync scoping**: anonymous users may not have write access to the collection containing the counter
2. **Concurrent updates**: two devices incrementing a counter with a plain read-modify-write update can lose an increment (per-field LWW picks one writer). Atomic `op.increment()` and fields declared `.merge('counter')` compose to the sum of both deltas instead, but the plain update pattern shown below does not
3. **Stale data**: the counter can drift from reality if any update is lost or filtered

**Instead, derive aggregated values from the actual data at query time.**

### Bad: Stored Counter

<!-- docs-check: skip deliberately bad example -->
```typescript
// DON'T: Store a counter that must be manually incremented
const schema = defineSchema({
  collections: {
    forms: {
      fields: {
        title: t.string(),
        responseCount: t.number().default(0), // fragile
      },
    },
    responses: {
      fields: {
        formId: t.string(),
        data: t.string(),
      },
    },
  },
})

// On submission - this can fail if the user can't write to 'forms'
await app.forms.update(formId, { responseCount: currentCount + 1 })
```

### Good: Derived Count

```tsx
// DO: Query the actual data to derive counts
function Dashboard() {
  const forms = useQuery(app.forms.where({ ownerId: userId }))
  const responses = useQuery(app.responses.where({}))

  // Compute counts from actual response records
  const responseCountMap = new Map<string, number>()
  for (const r of responses) {
    const fid = String(r.formId)
    responseCountMap.set(fid, (responseCountMap.get(fid) || 0) + 1)
  }

  const totalResponses = responses.length

  return (
    <div>
      <p>Total responses: {totalResponses}</p>
      {forms.map(form => (
        <FormCard
          key={form.id}
          form={form}
          responseCount={responseCountMap.get(form.id) || 0}
        />
      ))}
    </div>
  )
}
```

### When Stored Values Are Fine

Stored counters work when:
- Only one user/role ever updates the counter (no concurrent writes)
- The counter is in a collection the updater has write access to
- Exact accuracy isn't critical (e.g., a "views" counter where off-by-one is acceptable)
- The counter is updated with atomic `op.increment()` or declared `.merge('counter')`, so concurrent changes accumulate instead of overwriting

For everything else, derive from the source data. A counter that must be stored is best declared
`.merge('counter')` and written with atomic ops:

```typescript
await app.inventory.update(productId, { stock: op.decrement(1) })
```

---

## Transactions

When you need to update multiple records or collections as a single atomic unit, use `app.transaction()`. All mutations within the transaction either succeed together or fail together.

### Basic Transaction

```typescript
await app.transaction(async (tx) => {
  const order = await tx.orders.insert({ status: 'pending', total: 0 })

  for (const item of cartItems) {
    await tx.lineItems.insert({
      orderId: order.id,
      product: item.name,
      price: item.price,
      qty: item.qty,
    })
  }

  await tx.orders.update(order.id, {
    total: cartItems.reduce((sum, i) => sum + i.price * i.qty, 0),
  })
})
```

### Named Mutations

Use `app.mutation()` for transactions that should be identifiable in DevTools:

```typescript
await app.mutation('checkout', async (tx) => {
  await tx.orders.update(orderId, { status: 'confirmed' })
  await tx.inventory.update(productId, { reserved: true })
})
```

The name appears in the DevTools operation timeline, making it easy to trace related operations.

### When to Use Transactions

- Creating a parent record and its children together
- Updating multiple records that must stay consistent
- Any multi-step mutation where partial completion would leave invalid data

::: tip
Transactions are atomic on the device where they run: every write gets its own sequence number
inside the same commit, and secret fields, per-field versions and state machines are handled as
for single writes. On other devices the individual operations arrive by sync and merge like any
other operations.
:::

---

## Sequences

Sequences generate formatted, ordered identifiers like invoice numbers, order codes, or receipt IDs. They are offline-safe: each device maintains its own counter.

### Basic Usage

```typescript
const orderNo = await app.sequences.next('order')
// 'order-0001', 'order-0002', ...
```

### Custom Formats

```typescript
const receipt = await app.sequences.next('receipt', {
  format: 'REC-{date}-{seq:6}',
})
// 'REC-20260508-000001'
```

Available format tokens: `{seq}` (4 digits), `{seq:N}` (zero-padded to N), `{date}` (YYYYMMDD in UTC), `{node4}` and `{node8}` (the start of the device's node id). The default format is `{name}-{seq:4}`; `startAt` sets the first value.

### Scoped Sequences

Independent counters per scope, useful for per-store, per-tenant, or per-category numbering:

```typescript
// Each store gets its own sequence
const storeAReceipt = await app.sequences.next('receipt', { scope: 'store-A' })
const storeBReceipt = await app.sequences.next('receipt', { scope: 'store-B' })
// Both return 'receipt-0001' - independent counters
```

### Using Sequences with Records

```typescript
const orderNo = await app.sequences.next('order', { format: 'ORD-{node4}-{seq:4}' })

await app.mutation('create-order', async (tx) => {
  await tx.orders.insert({ orderNumber: orderNo, status: 'pending', total: 99.99 })
})
```

::: tip
Sequences are device-local counters. Two devices offline can produce the same counter value, so
include `{node4}` or `{node8}` in the format when values must not collide, or generate globally
sequential numbers on the server after sync.
:::

---

## Handling Auth Token Expiry

Expired tokens are handled for you: when the server ends a session as expired or revoked, Kora
asks the `auth` callback (or the `@korajs/auth` binding) for a fresh token and reconnects. Network
errors never sign anyone out. `sync:auth-failed` means the server refused even a fresh credential
(the device or user was revoked, the account deleted); sync is then suspended
(`status: 'auth-required'`) and the app should ask the user to sign in again:

```typescript
app.on('sync:auth-failed', ({ reason }) => {
  console.warn('Sync credential refused:', reason)
  void authClient.signOut()
})
```

---

## Server-Side Queries with Materialized Collections

When you need server-side data access (for API endpoints, webhooks, reports, or OG meta tags), use materialized collections:

```typescript
import { createProductionServer, createSqliteServerStore } from '@korajs/server'
import { defineSchema, t } from '@korajs/core'

// 1. Define your schema
const formsSchema = defineSchema({
  version: 1,
  collections: {
    forms: {
      fields: {
        title: t.string(),
        slug: t.string().default(''),
        status: t.string().default('draft'),
      },
      indexes: ['slug', 'status'],
    },
    responses: { fields: { formId: t.string(), data: t.string() }, indexes: ['formId'] },
  },
})

// 2. Enable materialization on the store
const store = createSqliteServerStore({ filename: './kora-server.db' })
await store.setSchema(formsSchema)

// 3. Query from your API endpoints
const server = createProductionServer({
  store,
  httpRoutes: [
    {
      path: '/api/forms',
      async handle(request) {
        const slug = request.path.slice('/api/forms/'.length)
        const [form] = await store.queryCollection('forms', {
          where: { slug, status: 'published' },
          limit: 1,
        })
        return form ? { status: 200, body: form } : { status: 404, body: { error: 'Not found' } }
      },
    },
    {
      // Count responses for a form
      path: '/api/stats',
      async handle(request) {
        const formId = request.path.slice('/api/stats/'.length)
        const count = await store.countCollection('responses', { formId })
        return { status: 200, body: { responseCount: count } }
      },
    },
  ],
})
```

::: tip
Materialized collection queries read the server's materialized tables, not the operation log.
Define `indexes` in your schema for fields you query frequently. For writes and scoped reads from
server code, prefer the route data plane (`request.kora`), which runs every write through the
server's validation; see [Production Server](/guide/production-server).
:::

---

## Multi-Collection Scoping

For apps where different users see different data, use sync scopes to restrict what each user syncs:

```typescript
import { TokenAuthProvider } from '@korajs/server'

// Server: each user only syncs their own data
const auth = new TokenAuthProvider({
  validate: async (token) => {
    const user = await verifyToken(token)
    if (!user) return null
    return {
      userId: user.id,
      scopes: {
        // User only sees their own forms
        forms: { ownerId: user.id },
        // User sees responses to their forms
        responses: { formOwnerId: user.id },
        // User sees all shared projects in their org
        projects: { orgId: user.orgId },
      },
    }
  },
})
```

The server enforces the grant in both directions:
- **Downloads**: only operations of records inside the grant, judged per operation from the scope
  values recorded when it was applied, so moving a record to another owner does not disclose its
  earlier history.
- **Uploads**: an operation is accepted only when the stored record and the resulting record are
  both inside the grant (never judged from client-sent values), and foreign keys must point at
  parents inside it.

Collections **not listed** in the grant are inaccessible. A client can only narrow the grant.
Moving a record out of a user's scope (ownership transfer) must go through a server route.

---

## Pagination

Use `limit` and `offset` for paginated queries:

```tsx
function PaginatedList() {
  const [page, setPage] = useState(0)
  const pageSize = 20

  // Re-runs reactively when the underlying data changes.
  const items = useQuery(
    app.todos
      .where({ completed: false })
      .orderBy('createdAt', 'desc')
      .limit(pageSize)
      .offset(page * pageSize),
  )

  return (
    <div>
      {items.map((item) => (
        <TodoItem key={item.id} todo={item} />
      ))}
      <button onClick={() => setPage(page + 1)}>Next</button>
    </div>
  )
}
```

`limit` and `offset` take non-negative integers (anything else is refused with a `QueryError`).

---

## Clearing Local Data

Kora stores data in **OPFS (Origin Private File System)** via SQLite WASM (or IndexedDB when OPFS is
unavailable), not in localStorage. Kora never deletes a database on its own. To clear local data:

### For Users

In Chrome: **Settings → Privacy and Security → Delete browsing data → Advanced → Site data** for your domain. This clears OPFS, IndexedDB, and all other site storage.

::: warning
"Clear localStorage" or "Clear site data" from DevTools may not clear OPFS. Use the browser settings for a complete reset.
:::

### Programmatically

```typescript
for (const database of await app.storage.listDatabases()) {
  console.log(database)
}
// Refuses with UnsyncedDataError while it holds writes the server never acknowledged, and
// with StorageInUseError while a tab has it open (close the app first).
await app.storage.deleteDatabase('kora-db')
```

Pass `{ force: true }` only when losing unsynced writes is acceptable. See
[Storage Configuration](/guide/storage-configuration#managing-local-databases).

---

## Multiple Related Collections

When your app has related collections, use the local query system to join data client-side:

```tsx
function FormWithResponses({ formId }: { formId: string }) {
  const forms = useCollection('forms')
  const responsesCol = useCollection('responses')

  // Get the form
  const [form] = useQuery(forms.where({ id: formId }))

  // Get all responses for this form
  const responses = useQuery(
    responsesCol.where({ formId }).orderBy('submittedAt', 'desc')
  )

  if (!form) return <p>Form not found</p>

  return (
    <div>
      <h1>{String(form.title)}</h1>
      <p>{responses.length} responses</p>
      {responses.map(r => (
        <ResponseCard key={r.id} response={r} />
      ))}
    </div>
  )
}
```

All data is local, so the rows arrive right after the first render (which returns `[]`). The `useQuery` hook re-renders automatically when new responses sync in.

---

## Error Recovery

### Handling Sync Errors

Listen for sync events to surface issues to users:

```typescript
app.on('sync:disconnected', () => {
  showToast('Working offline: changes will sync when connected')
})

app.on('sync:connected', () => {
  showToast('Back online: syncing changes')
})

app.on('sync:apply-failed', ({ code, message }) => {
  // An incoming operation could not be applied yet. It is quarantined, not lost,
  // and retried on the next start (or when the encryption keyring unlocks).
  console.warn('Quarantined incoming operation:', code, message)
})

app.on('sync:operation-rejected', ({ code, message }) => {
  // The server refused one of this device's writes; it is undone locally.
  showToast(`A change was refused: ${message} (${code})`)
})
```

### Pending Operations

Show users how many changes haven't synced yet:

```tsx
function SyncBadge() {
  const status = useSyncStatus()

  if (status.status === 'offline' && status.pendingOperations > 0) {
    return (
      <span>{status.pendingOperations} changes waiting to sync</span>
    )
  }

  return null
}
```

Pending operations are persisted locally; they survive page refreshes and app restarts. They'll sync automatically on the next successful connection.

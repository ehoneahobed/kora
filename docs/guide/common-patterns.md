# Common Patterns

Real-world apps go beyond basic CRUD. This guide covers patterns you'll encounter when building production applications with Kora.

---

## Anonymous / Public Data Access

Many apps need both authenticated and public access. For example:
- A **form builder** where signed-in users create forms, but anyone can submit responses
- A **survey tool** where respondents don't need accounts
- A **feedback widget** embedded on any website

Kora supports this with `MixedAuthProvider` on the server and anonymous sync on the client. Public users get full offline-first capabilities — their data saves locally and syncs when connected.

### Server Setup

Use `MixedAuthProvider` to accept both authenticated and anonymous connections. Anonymous users are restricted to specific collections via scopes:

```typescript
import { MixedAuthProvider, KoraSyncServer } from '@korajs/server'
import { BuiltInAuthRoutes, TokenManager } from '@korajs/auth/server'

const authRoutes = new BuiltInAuthRoutes({ userStore, tokenManager })

const auth = new MixedAuthProvider({
  primary: authRoutes.toSyncAuthProvider(),
  anonymousScopes: {
    // Anonymous users can only sync the 'responses' collection
    responses: {},
  },
})

const syncServer = new KoraSyncServer({ store, auth })
```

### Client Setup

Return an empty token when the user isn't signed in. The server accepts empty tokens as anonymous connections:

```typescript
import { createApp } from 'korajs'
import { authClient } from './auth'

const app = createApp({
  schema,
  sync: {
    url: syncUrl,
    auth: async () => ({
      // Returns token if authenticated, empty string for anonymous sync
      token: (await authClient.getAccessToken()) ?? '',
    }),
  },
})
```

### How It Works

1. Authenticated user connects → `MixedAuthProvider` validates their token via the primary provider → they get full access (or scoped access based on their role).
2. Anonymous user connects with empty token → `MixedAuthProvider` creates a scoped anonymous context → they can only sync collections listed in `anonymousScopes`.
3. Both users get full offline-first capabilities. Their data saves locally and syncs when connected.
4. The sync scope restricts which collections anonymous users can read and write. Operations targeting other collections are silently filtered out.

::: tip
Anonymous users' operations are synced to the server and visible to authenticated users who have access to those collections. This means a form owner can see all responses, even those submitted anonymously.
:::

---

## Derived Data (Don't Store Counters)

A common mistake is storing aggregated values (counts, sums, averages) as fields on a record, then trying to keep them in sync. This breaks in offline-first apps because:

1. **Sync scoping** — anonymous users may not have write access to the collection containing the counter
2. **Concurrent updates** — two devices incrementing a counter simultaneously can result in a lost increment (LWW picks one)
3. **Stale data** — the counter can drift from reality if any update is lost or filtered

**Instead, derive aggregated values from the actual data at query time.**

### Bad: Stored Counter

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

// On submission — this can fail if the user can't write to 'forms'
await app.forms.update(formId, { responseCount: currentCount + 1 })
```

### Good: Derived Count

```typescript
// DO: Query the actual data to derive counts
function Dashboard() {
  const forms = useQuery(app.forms.where({ ownerId: userId }))
  const responses = useQuery(app.responses.where({}))

  // Compute counts from actual response records
  const responseCountMap = new Map()
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

For everything else, derive from the source data.

---

## Handling Auth Token Expiry

When a user's session expires or the server resets, sync connections will fail authentication. Handle this gracefully with the `sync:auth-failed` event:

```typescript
app.events.on('sync:auth-failed', () => {
  console.warn('Sync auth failed — signing out stale session')
  authClient.signOut()
})
```

This automatically signs out the user and redirects to the login screen, instead of silently failing to sync.

---

## Server-Side Queries with Materialized Collections

When you need server-side data access (for API endpoints, webhooks, reports, or OG meta tags), use materialized collections:

```typescript
import { defineSchema, t } from '@korajs/core'

// 1. Define your schema
const schema = defineSchema({
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
  },
})

// 2. Enable materialization on the store
await store.setSchema(schema)

// 3. Query from your API endpoints
app.get('/api/forms/:slug', async (req, res) => {
  const [form] = await store.queryCollection('forms', {
    where: { slug: req.params.slug, status: 'published' },
    limit: 1,
  })

  if (!form) return res.status(404).json({ error: 'Not found' })
  res.json(form)
})

// Count responses for a form
app.get('/api/forms/:id/stats', async (req, res) => {
  const count = await store.countCollection('responses', {
    formId: req.params.id,
  })
  res.json({ responseCount: count })
})
```

::: tip
Materialized collection queries are indexed SQL queries — O(1) lookups, not operation log replays. Always define `indexes` in your schema for fields you query frequently.
:::

---

## Multi-Collection Scoping

For apps where different users see different data, use sync scopes to restrict what each user syncs:

```typescript
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

When scopes are set, the server filters operations in both directions:
- **Outbound**: Only sends operations matching the user's scopes
- **Inbound**: Only accepts operations targeting collections the user has access to

Collections **not listed** in scopes are inaccessible — the user won't sync any data for those collections.

---

## Pagination

Use `limit` and `offset` for paginated queries:

```typescript
function PaginatedList() {
  const [page, setPage] = useState(0)
  const pageSize = 20

  // Note: useQuery re-runs reactively when the underlying data changes
  const items = useQuery(
    app.todos
      .where({ completed: false })
      .orderBy('createdAt', 'desc')
      .limit(pageSize)
  )

  // For server-side pagination with queryCollection:
  // const items = await store.queryCollection('todos', {
  //   where: { completed: false },
  //   orderBy: 'createdAt',
  //   orderDirection: 'desc',
  //   limit: pageSize,
  //   offset: page * pageSize,
  // })

  return (
    <div>
      {items.map(item => <TodoItem key={item.id} todo={item} />)}
    </div>
  )
}
```

---

## Clearing Local Data

Kora stores data in **OPFS (Origin Private File System)** via SQLite WASM, not in localStorage or standard IndexedDB. To fully clear local data:

### For Users

In Chrome: **Settings → Privacy and Security → Delete browsing data → Advanced → Site data** for your domain. This clears OPFS, IndexedDB, and all other site storage.

::: warning
"Clear localStorage" or "Clear site data" from DevTools may not clear OPFS. Use the browser settings for a complete reset.
:::

### Programmatically

```typescript
// Sign out and clear auth tokens
await authClient.signOut()

// To fully reset the local database, the user needs to:
// 1. Close all tabs for the app
// 2. Clear site data via browser settings
// 3. Reopen the app (fresh sync on next visit)
```

---

## Multiple Related Collections

When your app has related collections, use the local query system to join data client-side:

```typescript
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
      <h1>{form.title}</h1>
      <p>{responses.length} responses</p>
      {responses.map(r => (
        <ResponseCard key={r.id} response={r} />
      ))}
    </div>
  )
}
```

Since all data is local, these queries are instant — no loading spinners needed. The `useQuery` hook re-renders automatically when new responses sync in.

---

## Error Recovery

### Handling Sync Errors

Listen for sync events to surface issues to users:

```typescript
app.events.on('sync:disconnected', ({ reason }) => {
  // Show offline indicator
  showToast('Working offline — changes will sync when connected')
})

app.events.on('sync:connected', () => {
  showToast('Back online — syncing changes')
})

app.events.on('sync:error', ({ error }) => {
  console.error('Sync error:', error)
  // Don't panic — local data is safe, sync will retry
})
```

### Pending Operations

Show users how many changes haven't synced yet:

```tsx
function SyncBadge() {
  const status = useSyncStatus()

  if (status.state === 'offline' && status.pendingOperations > 0) {
    return (
      <span>{status.pendingOperations} changes waiting to sync</span>
    )
  }

  return null
}
```

Pending operations are persisted locally — they survive page refreshes and app restarts. They'll sync automatically on the next successful connection.

# DevTools

Kora DevTools is a browser extension that gives you real-time visibility into your app's operations, sync state, and conflict resolution. It is built for debugging offline-first applications where understanding data flow across devices is essential.

## Installation

### From the Chrome Web Store

Install the Kora DevTools extension from the Chrome Web Store (search for "Kora DevTools"). It works in Chrome, Edge, Brave, and other Chromium-based browsers.

### From Source

For local development or contributing:

```bash
# From the Kora monorepo root
pnpm --filter @kora/devtools build

# Load the unpacked extension
# 1. Open chrome://extensions
# 2. Enable "Developer mode"
# 3. Click "Load unpacked"
# 4. Select packages/devtools/dist
```

## Enabling DevTools

DevTools connects to your Kora app automatically in development. Enable it explicitly in your app config:

```typescript
const app = createApp({
  schema,
  devtools: process.env.NODE_ENV === 'development',
})
```

When `devtools` is `true`, Kora emits instrumentation events that the DevTools extension consumes. In production builds, set this to `false` to eliminate the overhead.

## Opening DevTools

1. Open Chrome DevTools (F12 or Cmd+Opt+I).
2. Navigate to the **Kora** tab in the DevTools panel.
3. The panel connects automatically to the running Kora app on the page.

## Panels

### Sync Timeline

A horizontal timeline showing operations and sync events in chronological order.

**What you see:**

- **Operations** represented as colored dots: green for inserts, blue for updates, red for deletes.
- **Sync events** shown as vertical markers: connection established, disconnected, batch sent, batch received.
- **Causal arrows** connecting dependent operations, visualizing the operation DAG.

**How to use it:**

- Click any operation dot to inspect its full payload (type, collection, record ID, data, timestamp, causal dependencies).
- Zoom in/out to focus on specific time ranges.
- Filter by collection using the dropdown at the top.
- Use this panel to understand the sequence of events and verify that operations arrive in the expected order.

### Conflict Inspector

A table of all merge events, showing how conflicts were detected and resolved.

**What you see:**

| Column | Description |
|--------|-------------|
| Time | When the merge occurred |
| Collection | Which collection was affected |
| Field | The specific field with a conflict |
| Tier | Which merge tier resolved it (1, 2, or 3) |
| Strategy | The strategy applied (LWW, CRDT, constraint, custom) |
| Local | The local value |
| Remote | The remote value |
| Result | The resolved value |

**How to use it:**

- Click any row to expand the full `MergeTrace`, showing the base value, both input values, the output, and the duration of the merge.
- Filter by tier to focus on specific resolution strategies.
- Filter by collection or field name.
- Sort by time to see the most recent conflicts first.
- Use this panel to verify that your constraints and custom resolvers produce the expected results.

### Operation Log

A searchable, filterable list of every operation in the local store.

**What you see:**

- Every insert, update, and delete operation with its full payload.
- The operation ID (content-addressed hash).
- The HLC timestamp and sequence number.
- The causal dependencies.
- The schema version at time of creation.

**How to use it:**

- Search by record ID, collection name, or field values.
- Filter by operation type (insert, update, delete).
- Filter by sync status (synced, pending, failed).
- Click any operation to see the state of the record at that point in time (time-travel debugging).
- Use this panel to trace the history of a specific record and understand how it reached its current state.

### Network Status

Real-time monitoring of the sync connection.

**What you see:**

- **Connection state**: Connected, disconnected, reconnecting.
- **Pending operations**: Count of operations queued for sync.
- **Bandwidth graph**: Data sent and received over time.
- **Last sync**: Timestamp of the most recent successful sync.
- **Latency**: Round-trip time to the sync server.
- **Version vector**: The current version vector for this client and the server.

**How to use it:**

- Monitor pending operation count to ensure changes are syncing.
- Check bandwidth usage to identify unexpectedly large sync payloads.
- Verify that reconnection happens correctly after network interruptions.
- Compare version vectors between client and server to diagnose sync gaps.

## Debugging Common Issues

### "Why did this field change?"

1. Open the **Operation Log**.
2. Search for the record ID.
3. Find the most recent update operation that changed the field.
4. Check its `nodeId` to see which device made the change.
5. Check its `timestamp` and `causalDeps` to understand the context.

### "Why did this conflict resolve this way?"

1. Open the **Conflict Inspector**.
2. Find the merge event for the field in question.
3. Expand the row to see the full `MergeTrace`.
4. The trace shows the tier, strategy, base value, local value, remote value, and the resolved output.
5. If the resolution was unexpected, check your schema's constraints and custom resolvers.

### "Why is data not syncing?"

1. Open the **Network Status** panel.
2. Check the connection state. If disconnected, check the server URL and auth configuration.
3. Check the pending operations count. If operations are pending, the connection may be interrupted or the server may not be acknowledging.
4. Check the version vectors. If the client's vector is ahead of the server's, operations have not been sent. If the server's vector is ahead, operations have not been received.
5. Open the **Sync Timeline** and look for error events.

### "Why is the initial sync slow?"

1. Open the **Network Status** panel and check bandwidth.
2. Check the operation count. A large number of operations means more data to sync.
3. Consider adding [sync scopes](/guide/sync-configuration#sync-scopes) to reduce the amount of data each client syncs.
4. Check whether operation compaction has been run on the server to reduce historical operations.

## Performance Overhead

DevTools instrumentation adds minimal overhead:

- **Enabled** (`devtools: true`): Events are serialized and posted to the extension via `window.postMessage`. Expect less than 1ms per operation.
- **Disabled** (`devtools: false`): No instrumentation code runs. Zero overhead.
- **Extension not installed**: If `devtools: true` but the extension is not installed, events are posted but not consumed. The overhead is negligible.

Always disable DevTools in production builds for the cleanest performance.

## Extending DevTools

Kora DevTools consumes events emitted by the core instrumentation layer. You can also listen to these events programmatically:

```typescript
app.on('operation:created', (event) => {
  console.log('New operation:', event.operation)
})

app.on('merge:conflict', (event) => {
  console.log('Conflict resolved:', event.trace)
})

app.on('sync:sent', (event) => {
  console.log('Sent', event.operations.length, 'operations')
})
```

This is useful for custom logging, analytics, or building your own debugging tools.

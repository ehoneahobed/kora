# @korajs/devtools

Browser DevTools extension for Kora.js. Inspect operations, trace conflict resolution decisions, monitor sync status, and debug your offline-first app in real time.

## Install

```bash
pnpm add -D @korajs/devtools
```

## Enable

Add `devtools: true` to your app config:

```typescript
import { createApp } from 'korajs'

const app = createApp({
  schema,
  devtools: process.env.NODE_ENV === 'development',
})
```

When enabled, the Kora DevTools panel appears in your browser's developer tools.

## Panels

### Sync Timeline
Horizontal timeline of operations and sync events, color-coded by type. Click any event to inspect it. Causal arrows show dependencies between operations.

### Conflict Inspector
Table of all merge events, filterable by collection, tier, and strategy. Expand any row to see the full `MergeTrace` -- input values, base value, resolved output, and which tier handled it.

### Operation Log
Searchable list of all operations. Click an operation to view its full payload, causal dependencies, and the database state at that point in time.

### Network Status
Real-time connection quality indicator, pending operation count, bandwidth graph, and last sync timestamp.

## Instrumentation Events

The DevTools extension listens for events emitted by the Kora runtime:

- `operation:created` / `operation:applied`
- `merge:started` / `merge:completed` / `merge:conflict`
- `sync:connected` / `sync:disconnected` / `sync:sent` / `sync:received`
- `query:subscribed` / `query:invalidated` / `query:executed`
- `connection:quality`

## Keyboard Shortcut

In development mode, press `Ctrl+Shift+K` (or `Cmd+Shift+K` on macOS) to toggle the embedded DevTools overlay.

## License

MIT

See the [full documentation](https://github.com/ehoneahobed/kora) for guides, API reference, and examples.

# @korajs/devtools

Browser DevTools extension for Kora.js. Inspect operations, trace conflict resolution decisions, monitor sync status, and debug your offline-first app in real time.

## Install

`korajs` already depends on `@korajs/devtools`; apps only turn it on. Install it directly to use
the building blocks (`Instrumenter`, `EventBuffer`, the panel renderer) in your own tooling:

```bash
pnpm add -D @korajs/devtools@beta
```

## Enable

<!-- docs-check: standalone -->
```typescript
import { createApp, defineSchema, t } from 'korajs'

const schema = defineSchema({ version: 1, collections: { todos: { fields: { title: t.string() } } } })

const app = createApp({
  schema,
  devtools: import.meta.env.DEV,
})
```

With `devtools: true`, Kora records instrumentation events and:

- mounts an in-page overlay, toggled with `Ctrl+Shift+K` (`Cmd+Shift+K` on macOS);
- forwards events to the browser extension. The extension is not published to a store yet: build
  it with `pnpm --filter @korajs/devtools build` in the Kora repository and load
  `packages/devtools/dist/extension` as an unpacked extension in a Chromium browser.

## Panels

- **Timeline**: recorded events in order, color-coded by type.
- **Conflicts**: every merge conflict with its strategy, tier, inputs and result.
- **Operations**: operations created on this device and applied from sync, with payload, node,
  sequence number and causal dependencies.
- **Network**: connection state and quality, operations sent and received, last sync, and a
  version vector derived from the recorded operations.

The panels show events recorded since the page loaded. The complete event catalog is in the
[DevTools API reference](https://korajs.dev/api/devtools#events).

## License

MIT

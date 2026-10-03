# @korajs/sync

The sync engine of Kora.js: protocol v2 over WebSocket or HTTP long-polling, an outbound queue that
survives reloads, gap-free resumable downloads, reconnection with backoff, end-to-end encryption
and presence.

> Most apps do not install this directly: `createApp({ sync: { url } })` from
> [`korajs`](https://www.npmjs.com/package/korajs) creates and runs the engine.

## Install

```bash
pnpm add @korajs/sync@beta
```

## Usage

<!-- docs-check: standalone -->
```typescript
import { createApp, defineSchema, t } from 'korajs'

const schema = defineSchema({ version: 1, collections: { todos: { fields: { title: t.string() } } } })

const app = createApp({
  schema,
  sync: { url: 'wss://sync.example.com/kora-sync', autoConnect: true },
})

app.sync?.subscribeStatus((status) => {
  console.log(status.status, status.pendingOperations)
})
app.events.on('sync:operation-rejected', (event) => console.warn(event.code, event.message))
```

`SyncEngine`, `WebSocketTransport`, `HttpLongPollingTransport`, `ChaosTransport`, the protocol
message types and the encryption keyring are exported for custom runtimes and tests.

## Protocol

1. **Handshake**: protocol version, schema version, the client's version vector and scope; the
   server answers with its grant, its time (clock skew) and the delivery position to resume from.
2. **Upload**: the operations the server has not acknowledged, in causal order.
3. **Download**: batches chained by server delivery sequence. The client applies a batch only when
   it continues its durable watermark, so a dropped or failed operation is re-sent, never skipped.
4. **Streaming**: both directions continue in real time; heartbeats detect dead connections.

Operations are content-addressed, so a duplicate is a no-op. Messages are JSON.

## Documentation

[Sync Configuration](https://korajs.dev/guide/sync-configuration),
[Sync Protocol](https://korajs.dev/guide/sync-protocol) and the
[Sync API reference](https://korajs.dev/api/sync).

## License

MIT

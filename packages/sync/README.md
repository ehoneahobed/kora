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
`summarizeSyncStatus(status)` turns a status into what a sync indicator shows (tone, title, one
line of detail). Smaller entry points keep a bundle lean: `@korajs/sync/lite` (what the first paint
needs, before the engine loads), `@korajs/sync/read` (the read-through client) and
`@korajs/sync/protobuf` (the opt-in protobuf serializers).

## Protocol

1. **Handshake**: protocol version, schema version, the client's version vector and scope; the
   server answers with its grant, its time (clock skew) and the delivery position to resume from.
   Servers refuse protocol 1 (Kora 1.0.0-beta.12 and earlier).
2. **Upload**: the operations the server has not acknowledged, in causal order.
3. **Download**: batches chained by server delivery sequence. The client applies a batch only when
   it continues its durable watermark, in one storage transaction with the watermark advance, so a
   dropped or failed operation is re-sent, never skipped. A large first sync is staged in a scratch
   replica and merged once.
4. **Streaming**: both directions continue in real time; heartbeats detect dead connections.

Operations are content-addressed, so a duplicate is a no-op. Messages are JSON.

## Documentation

[Sync Configuration](https://korajs.dev/guide/sync-configuration),
[Sync Protocol](https://korajs.dev/guide/sync-protocol) and the
[Sync API reference](https://korajs.dev/api/sync).

## License

MIT

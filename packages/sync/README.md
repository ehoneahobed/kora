# @korajs/sync

Sync protocol and transports for Kora.js. Handles version vector delta sync, causal ordering, Protobuf wire format, and automatic reconnection with operation queuing.

> Most developers don't install this directly. Use [`korajs`](https://www.npmjs.com/package/korajs) instead.

## Install

```bash
pnpm add @korajs/sync
```

## Usage

### WebSocket Transport

```typescript
import { SyncEngine, WebSocketTransport } from '@korajs/sync'

const transport = new WebSocketTransport({
  url: 'wss://my-server.com/kora',
  auth: async () => ({ token: await getAuthToken() }),
})

const sync = new SyncEngine({
  transport,
  mergeEngine,
  operationLog,
})

sync.start()
```

### HTTP Transport

```typescript
import { HttpTransport } from '@korajs/sync'

const transport = new HttpTransport({
  url: 'https://my-server.com/kora/sync',
  pollInterval: 5000,
})
```

### Sync Events

```typescript
sync.on('connected', () => console.log('Connected'))
sync.on('disconnected', (reason) => console.log('Disconnected:', reason))
sync.on('sent', (ops) => console.log('Sent', ops.length, 'operations'))
sync.on('received', (ops) => console.log('Received', ops.length, 'operations'))
```

## Protocol

1. **Handshake** -- exchange version vectors to determine what each side is missing
2. **Delta sync** -- send only the operations the other side doesn't have
3. **Real-time streaming** -- bidirectional operation flow after initial sync
4. **Resumable** -- reconnects pick up from the last acknowledged sequence number

Operations are always sent in causal order. The protocol is idempotent -- duplicate operations are detected via content-addressing and safely ignored.

## License

MIT

See the [full documentation](https://github.com/ehoneahobed/kora) for guides, API reference, and examples.

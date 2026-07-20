# Kora Studio

Kora Studio is the visual window into Kora's data plane. Where a generic
database browser shows you rows, Studio shows you the sync dimension no other
tool can: who wrote each field and when, the operation history behind every
record, concurrency as a picture, and time as a dimension you can scrub.

## File mode

```bash
kora studio --db path/to/kora.db
```

Read-only inspection of any Kora SQLite database (server databases, Node,
Electron, Tauri apps, backups, test fixtures). No schema file needed —
collections are introspected from the database itself. The database is opened
`readonly` and non-GET requests are rejected: Studio can never write to your
data.

- **Data** — records per collection, search, tombstone toggle. Every record
  opens a drawer showing each field's *last writer* (device and time, from the
  per-field LWW register), decoded richtext previews, the record's causal
  graph, and its full operation history.
- **Operations** — the append-only log, plus a causal DAG: one lane per
  device, edges are causal dependencies, so concurrent edits are literally
  visible as parallel branches.
- **Time Travel** — a slider over the operation log. Pick any operation and
  see the entire collection exactly as it was at that causal cut; press play
  to watch history unfold.
- **Merges** — the persisted merge audit trail (strategy, tier, field, when).
- **Sync** — version vector, outbound queue, store meta.

The UI live-updates when the database changes (SQLite `data_version` polling
over server-sent events).

## Lab mode

```bash
kora studio --lab            # built-in demo schema, 2 devices
kora studio --lab --devices 3 --schema ./kora/schema.ts
```

An interactive multi-device sync laboratory. Every device is a REAL Kora
client — its own SQLite store, sync engine, and merge pipeline — connected to
a REAL in-process sync server. Nothing at the data layer is simulated, so
what you see is evidence of shipped behavior:

- Create devices; insert, edit, and delete records **on a specific device**.
- Disconnect devices, make conflicting edits, and watch the convergence
  banner turn red with the exact differences; reconnect and sync to watch it
  turn green.
- Per-device chaos controls (drop / duplicate / reorder / latency) applied on
  the next connect — then watch convergence hold anyway.
- Atomic increment buttons demonstrate intent composition: +1 on two offline
  devices converges to +2 everywhere, never last-write-wins.
- A live event feed narrates every operation created and applied, every sync
  message, and every merge decision, per device, in real time.
- Every file-mode view (per-field writers, DAG, time travel) works per
  device: pick a device in the tab bar and inspect its private view of the
  world.

The Lab only ever touches throwaway databases in a temp directory.

## Spectator mode

```bash
kora studio --connect wss://your-server.com/kora --schema ./kora/schema.ts [--token …]
```

Live, read-only inspection of a PRODUCTION sync server. The spectator is a
real Kora client — its own store, merge pipeline, and sync engine — connected
over the real WebSocket protocol. Its version vector starts empty, so the
server sends the full history (production time travel included), and new
operations stream in live. It exposes no mutation surface, so it can never
push an operation: it receives, applies, and observes. All Studio views work
on the live replica, and the Sync tab shows the live event feed.

## Design commitments

1. **Read-only against real data.** Any future editing feature must create
   real operations through the store pipeline — never raw SQL — or it would
   corrupt the append-only log and violate content addressing.
2. **Zero dependencies, works offline.** One self-contained UI served by
   `node:http`; no CDN, no build step.
3. **Local only.** Binds to 127.0.0.1.

## Roadmap (post-0.7.0)

- Browser-app inspection: unify with the DevTools extension so OPFS stores
  get the same surface.
- Diff view between two devices at a chosen causal cut.
- Export a Lab session as a reproducible convergence test.

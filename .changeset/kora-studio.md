---
"@korajs/cli": minor
---

New command: `kora studio` — the visual window into Kora's data plane, in two
modes.

FILE mode (`kora studio --db path/to/db.sqlite`) inspects any Kora database,
strictly read-only: records with each field's LAST WRITER (which device
changed it, and when), the full operation history behind every record, a
causal DAG that makes concurrency visible as parallel device lanes, TIME
TRAVEL (scrub to any operation and see the exact state at that causal cut,
with animated replay), tombstones, the outbound sync queue, the version
vector, and the merge audit trail. Live-updates via server-sent events when
the database changes. No schema file needed; no extra dependencies; the UI is
fully self-contained and offline.

LAB mode (`kora studio --lab`) is an interactive multi-device sync
laboratory: real Kora clients (own store, sync engine, merge pipeline)
against a real in-process sync server. Create devices, edit records on each,
disconnect them, make conflicting edits, watch the convergence banner flip to
DIVERGED, reconnect, and watch every device converge — with a live event feed
showing each operation, sync message, and merge decision as it happens.
Chaos controls per device (drop, duplicate, reorder, latency) and atomic
increment buttons demonstrate composition: +1 on two offline devices merges
to +2, never lost. Everything in the Lab is throwaway; it can never touch
real data. Optionally bring your own schema with `--schema`.

SPECTATOR mode (`kora studio --connect wss://… --schema ./kora/schema.ts`)
attaches to a LIVE production sync server as a real, read-only Kora client
over the real WebSocket protocol: full history on connect (production time
travel), live operation streaming, per-field writers, causal DAG, and merge
audit — with no mutation surface, so it can never write to production.

Studio answers the hardest question in a synced app — "why does this record
look like this on this device?" — with evidence, not logs.

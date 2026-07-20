---
title: Clock Integrity
description: "How Kora.js handles wrong device clocks: HLC drift protection, server timestamp validation, clock skew detection at handshake, and what your users see."
---

# Clock Integrity

Kora orders concurrent edits with Hybrid Logical Clocks (HLC), which combine each device's wall clock with a logical counter. Wall clocks are wrong all the time: dead RTC batteries, manually set time, drifted VMs. This page explains exactly what Kora does about that, what your app gets for free, and what your users see.

The design follows one rule above all others: **a wrong clock never blocks local writes.** The user's data always outranks the quality of its timestamps.

## The threat model

A device with a **fast clock** (set in the future) stamps its operations ahead of everyone else's. Under last-write-wins, those operations would beat legitimately newer edits from other devices, and because HLC adopts the maximum wall time it sees, one bad clock could drag every replica's clock forward permanently. A device with a **slow clock** only disadvantages itself: its writes lose conflicts they might deserve to win. Slow is annoying; fast is dangerous.

## The four layers of protection

**1. Server ingest validation.** The sync server rejects any operation stamped more than 60 seconds ahead of server time (`INVALID_TIMESTAMP`). This is the load-bearing wall: it keeps future timestamps out of the shared operation log, so a bad clock stays a local problem with a local fix. Operations are content-addressed and immutable, so poison that reached the shared log could never be removed.

**2. Validate-before-adopt on every replica.** When a client receives a remote operation, its HLC validates the timestamp against reference-corrected local time *before* adopting any state. A timestamp more than 5 minutes ahead is rejected (`RemoteClockDriftError`) and cannot poison the local clock.

**3. Skew measurement at handshake.** The server includes its own wall-clock time in every handshake response. The client computes its skew (`serverTime - localTime`) and acts on it:

| Measured skew | Status | Behavior |
|---|---|---|
| Within ±60s | normal | Nothing. Clocks are never perfectly aligned. |
| More than 60s **fast** | `clock-error` | Sync pauses (the server would reject the writes anyway). Local writes continue and queue. A `sync:clock-skew` event fires with `severity: 'fast-blocked'`. Once the clock is corrected, the queued operations are re-stamped automatically (see below) and sync resumes. |
| More than 10min **slow** | normal | Sync continues. A `sync:clock-skew` event fires with `severity: 'slow-warning'` so you can inform the user. |

The measured skew is also fed into the store's HLC as a reference offset, so a device with a wrong clock still validates *remote* timestamps correctly. That matters for the subtle case of a slow local clock receiving legitimate timestamps that look "future" from its warped perspective.

**4. Drift reporting, never write-blocking.** If the physical clock falls behind the HLC (typically because the user just corrected a fast clock), `now()` keeps issuing monotonic timestamps by freezing wall time and advancing the logical counter. Drift is reported through callbacks and events instead of exceptions. Local inserts, updates, and deletes never fail because of clock state.

## What your app gets with zero work

The sync status now includes everything you need:

```ts
const status = useSyncStatus()
status.status        // 'clock-error' when sync is paused due to a fast clock
status.clockSkewMs   // serverTime - localTime; negative = this device is fast
```

The scaffolded templates already render a plain-language banner when `status.status === 'clock-error'`, written for non-technical users:

> This device's clock looks wrong (about 12 min ahead). Your changes are safe on this device, but they can't be shared with your other devices until the clock is corrected. Open your device's Settings, find Date & Time, and turn on "Set automatically", then return here.

That's the entire end-user experience: no dialogs, no decisions they can't evaluate, no data loss. They fix the clock (or ask someone to), reopen the app, and sync resumes.

For custom handling, subscribe to the event:

```ts
app.events?.on('sync:clock-skew', (event) => {
  // event.skewMs     serverTime - localTime in ms
  // event.severity   'info' | 'slow-warning' | 'fast-blocked'
  // event.source     'handshake' | 'server-reject'
})
```

After the user corrects the clock, call `app.sync?.engine?.clearClockBlock?.()` or simply restart the app; the next handshake re-measures, clears the block automatically when the measured skew is acceptable, and re-stamps any queued future-dated operations so they sync immediately.

## Why slow clocks warn instead of block

A device that reports a time far in the past is indistinguishable from a device that has legitimately been offline for weeks, which is a first-class citizen in an offline-first framework. Blocking or interrogating those users would punish exactly the field-work scenarios Kora exists for. The cost of a slow clock is bounded and self-inflicted (its writes lose LWW conflicts), so the default is to warn through the event and let your app decide whether to surface it. If your domain needs stricter behavior, listen for `severity: 'slow-warning'` and gate whatever you like.

## The unsolvable case, and why it's fine

A device that has been offline since first boot with a wrong clock cannot detect that fact: it has no reference. But wrong timestamps only cause harm at a merge, and merges only happen after connecting, which is exactly when the reference appears and every layer above activates. Offline, the wrong clock is harmless: a single writer's local order comes from the operation log sequence, not wall time.

## Timestamp rebase (automatic)

Operations queued with a fast clock are re-stamped automatically once the clock is corrected. At the next handshake, when the measured skew is back within tolerance, the engine:

1. **Auto-heals the block.** An acceptable measured skew is authoritative proof the clock was fixed, so `clockBlocked` clears without any call to `clearClockBlock()`.
2. **Detects stale future stamps.** If any queued (never-acknowledged) operation is stamped more than 60 seconds ahead of the server's handshake time, a rebase runs *before* the delta exchange begins, so only re-stamped operations ever reach the wire.
3. **Re-stamps in place, preserving order.** The unsynced operations are sorted by their original HLC total order and assigned fresh timestamps on a single wall time chosen to sort after both corrected "now" and every operation that stays in the log. Because timestamps are part of the content hash, each operation gets a new content-addressed id; causal dependencies between rebased operations are remapped to the new ids. Materialized row version stamps that came from rebased operations are updated to match. The store's HLC then advances past the highest new timestamp so subsequent writes keep sorting after the rebased ones.
4. **Emits `sync:clock-rebase`.** The event carries `rebasedCount` and `maxSkewMs` (how far ahead the most future queued operation was) for DevTools and custom handling.

This rewrite is safe precisely because unacknowledged operations have never been shared: like rewriting unpushed git commits, no other replica can hold a reference to the old ids or timestamps. Acknowledged operations are immutable forever and are never touched. If the rebase itself fails (e.g. a storage error), the handshake continues with the old operations; the server rejects them with `INVALID_TIMESTAMP` and the clock-block path takes over, so no data is ever lost.

Stores that implement the sync contract by hand simply omit `rebaseUnsyncedOperations` and keep the previous behavior (sync stays blocked until timestamps become valid).

## Timestamp encoding

HLC timestamps serialize to a string that must sort lexicographically in exactly the same order as `HybridLogicalClock.compare`: a zero-padded 15-digit wall time, a zero-padded 5-digit logical counter, and the node id (`000001712188800000:00042:node-abc` style). Stored `_version` and `_field_versions` columns and the operation log rely on that property for every LWW comparison, so both components are hard-bounded:

- **The logical counter is capped at 99,999** (`MAX_LOGICAL`, exported from `@korajs/core`). When an increment would exceed the cap — reachable when the physical clock is frozen behind the HLC (drift-freeze after a corrected fast clock) and every write increments the counter — the clock **carries into wall time** instead: wall time advances by 1ms and the counter resets to 0. Monotonicity and serialized ordering are both preserved. `receive()` rejects remote timestamps with non-integer or negative fields or a logical counter beyond the cap (`InvalidTimestampError`, code `INVALID_TIMESTAMP_FIELDS`) before adopting any state, and the sync server rejects such operations at ingest.
- **Wall time has a 15-digit horizon** (10^15 ms, roughly the year 33658). `serialize()` throws on values at or beyond it — unreachable by honest clocks, this only guards against hand-built timestamps that would silently overflow the padded slot and corrupt lexicographic ordering.

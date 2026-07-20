---
"@korajs/core": minor
"@korajs/sync": minor
"@korajs/server": minor
"@korajs/store": minor
"korajs": minor
"@korajs/devtools": patch
"@korajs/cli": patch
---

Clock integrity: protection against wrong device clocks at every layer.

- HLC now validates remote timestamps BEFORE adopting them (`RemoteClockDriftError`),
  so a far-future timestamp can no longer poison a replica's clock.
- Local timestamp generation never throws and never blocks writes: drift is
  reported through callbacks and `sync:clock-skew` events instead.
- The sync handshake now carries `serverTime`; clients measure their own skew,
  pause sync with a new `clock-error` status when the device clock is more than
  60s fast (local writes keep queuing), and warn via events when it is very slow.
- `SyncStatusInfo` gains `clockSkewMs`; the store's HLC receives the measured
  offset so remote validation works even on devices with wrong clocks.
- Scaffolded templates render a plain-language banner telling end users how to
  fix their device clock. See the new Clock Integrity guide.
- Automatic timestamp rebase: after the clock is corrected, the next handshake
  clears the clock block on its own and re-stamps queued never-acknowledged
  operations (new content-addressed ids, causal deps remapped, original order
  preserved) so sync resumes immediately instead of waiting for real time to
  catch up. A new `sync:clock-rebase` event reports `rebasedCount` and
  `maxSkewMs`. Safe because unacknowledged operations are private to the
  device — like rewriting unpushed git commits.
- Bounded logical counter with carry: the HLC logical counter is capped at
  99,999 (`MAX_LOGICAL`, exported from `@korajs/core`) so serialized timestamps
  always sort lexicographically identically to `HybridLogicalClock.compare`.
  Overflow carries into wallTime (+1ms, counter resets) in `now()`, `receive()`,
  and `advanceTo()`; malformed timestamps (non-integer/negative fields, logical
  past the cap) are rejected with `InvalidTimestampError`
  (`INVALID_TIMESTAMP_FIELDS`) before any clock state changes, both at the
  replica and at server ingest.
- Canonical binary encoding in op payloads: richtext `Uint8Array`/`ArrayBuffer`
  values are normalized to a tagged `{ $koraBytes: base64 }` form in
  `op.data`/`op.previousData` at operation creation, BEFORE content hashing, so
  the hash input, persisted JSON, and wire payload are the identical value and
  operation ids survive persistence round-trips. Plain-string richtext values
  are untouched (existing operation ids are unaffected); apply paths decode the
  tagged form (and tolerate the pre-fix numeric-key shape from dev databases)
  back to bytes.

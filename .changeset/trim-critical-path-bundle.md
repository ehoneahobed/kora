---
"korajs": patch
"@korajs/sync": patch
"@korajs/core": patch
"@korajs/devtools": patch
---

Smaller critical-path JavaScript for a web app (first-visit parity, K3): Kora's share of the `react-tailwind-sync` template's entry bundle drops from 277.2 KB to 242.1 KB gzip (970.9 KB to 840.8 KB raw), with no behavior or wire-format change.

- DevTools (`@korajs/devtools`, Preact, htm) loads with a dynamic `import()` only when `devtools` is on. Events emitted before it loads are held and replayed into the instrumenter in order (`Instrumenter.replay`, `SimpleEventEmitter.onAny`).
- protobufjs is an explicit opt-in. `ProtobufMessageSerializer` and `NegotiatedMessageSerializer` keep their `@korajs/sync` exports and are also available from the new `@korajs/sync/protobuf`; `@korajs/sync` is now `sideEffects: false` so they are dropped from a bundle that does not use them. The sync engine's default serializer is `JsonMessageSerializer`; `HttpLongPollingTransport` still defaults to the negotiated serializer (JSON unless told otherwise), loaded on connect.
- The beta.12 pairwise merge pipeline loads only with `experimental.legacyMerge`.
- `MergeAwareSyncStore` accepts `undefined` for its merge engine, and `initializeApp` no longer takes one.

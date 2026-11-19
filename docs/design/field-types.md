# Design: structured, secret and binary field types

Scope: `t.object()`, `t.json()`, `t.secret()` and `t.blob()`. Builders live in
`packages/core/src/schema/types.ts`; merge behaviour in `packages/core/src/fold/`. User-facing
reference: `docs/guide/schema-design.md` (value domains, storage per backend) and
`docs/guide/conflict-resolution.md` (merge behaviour).

## Problem

The scalar kinds (string, number, boolean, enum, timestamp), arrays and rich text cover most
fields, but three common needs fall outside them:

- **Structured values** such as a settings object or a form definition. Treated as one opaque
  last-write-wins value, two devices editing different keys offline lose one edit on reconnect,
  which is exactly what an offline-first framework exists to prevent.
- **Secrets** such as tokens and password hashes. They must never appear in plaintext in the
  operation log, merge traces, events, DevTools or logs.
- **Files.** The operation log is append-only and re-synced to every new device, so bytes stored
  in it are a permanent payload that also exceeds the operation size limit (256 KiB of operation
  JSON).

## `object` and `json`: per-key merge

- `t.object({ ...fields })` declares a shape whose keys follow their own builders.
  `t.json<T>()` holds any JSON value; `T` is compile-time only.
- Both fold as a **key map** (`object-key-lww` in the fold plan): each top-level key is its own
  last-write-wins register, ordered by HLC stamp. A write stamps only the keys it changed
  relative to its `previousData`, so concurrent edits to different keys both survive. A key
  present in `previousData` and absent from the new value is a stamped removal, and the later
  of a removal and a write to that key wins.
- Nested values are replaced whole: two concurrent edits inside the same top-level key resolve by
  last-write-wins on that key. Recursion was left out on purpose: a per-key fold over top-level
  keys is commutative, associative and idempotent with a small, inspectable state, and apps that
  need finer granularity can split the value into more top-level keys or separate fields.
- Writing a non-object value (for example `null`, or a scalar into a `json` field) records the
  value's shape with its stamp and clears every key stamped before it.
- Storage: JSON text (SQLite) or JSONB (Postgres); wire: JSON. Values must have a canonical JSON
  form (no `Map`, `Set`, class instances, cycles, `NaN`, or an own `__proto__` key; at most 64
  levels deep); `undefined` inside an object value is dropped, as `JSON.stringify` does.
- In a scope entry, deleted keys keep their stamps under a salted digest with the value removed,
  so a late write cannot resurrect them on a reader that never saw the value
  (`docs/design/server-fold-authority.md`).

## `secret`: protected at rest, redacted everywhere

- `t.secret()` takes a string. Two modes:
  - `.encrypted()` (the default): reversible AES-256-GCM, for tokens and API keys that must be
    read back (`revealSecret`).
  - `.hashed()`: one-way PBKDF2-SHA-256 with a random salt, for passwords
    (`verifySecretValue`).
- **Transformed before the operation exists.** `transformSecretFieldsForWrite` replaces each
  secret value with its at-rest form before the operation is created, so plaintext never enters
  the operation log, the local store or the sync stream. The primitives use only WebCrypto, so
  they live in `@korajs/core` (which may not depend on `@korajs/auth`).
- **Key.** Encrypted secrets use the app's `sync.encryption.key` (a string, or a provider called
  on demand), whether or not wire encryption is enabled. Writing or revealing an encrypted
  secret with no key throws `MissingSecretKeyError`; there is no plaintext fallback.
- **Merge.** Last-write-wins on the at-rest value; the fold never sees plaintext.
- **Redaction.** For a secret field the fold writes `[secret]` in place of every value in its
  merge trace (inputs, base, output) and redacts the field in the operation the trace carries,
  so DevTools and `merge:*` events never show it. Form drafts never store a `t.secret()` field
  (`docs/design/version-gate.md`).

## `blob`: content-addressed, out of band

- A `t.blob()` field holds a **reference**, `BlobRef`: the SHA-256 content hash of the bytes,
  the size, optional MIME type and filename, and `manifestHash` when the blob was stored for
  transfer. The reference is a small last-write-wins value in the log; the bytes never are.
  A list of attachments is a `t.array()` of references and merges like any array.
- **Store.** Bytes live in a content-addressed store, deduplicated by hash: OPFS in the browser
  (`opfs-blob-store.ts`), the filesystem or an object store (S3, Azure) on the server
  (`@korajs/store/blob-fs`, `@korajs/store/blob-object`).
- **Transfer.** `app.blobs.put(bytes, metadata)` splits the blob into 256 KiB content-addressed
  chunks, stores them, and stores a **manifest** (the ordered chunk hashes) as its own
  content-addressed object; the returned reference carries `manifestHash`. A peer that receives
  the reference calls `app.blobs.pull(ref)`: it fetches the manifest, then only the chunks it does
  not already hold, over the sync connection's blob-chunk messages, and verifies every chunk and
  the reassembled blob by re-hashing. Identical chunks across blobs are stored and sent once.
  Without a connection local reads still work and `pull` rejects with `BLOB_SYNC_UNAVAILABLE`.
  An unanswered chunk request is re-sent under the same request id (after 5 s, then a wait
  doubling to 30 s) and on every reconnect, and fails with `BlobTransferError` only after 2
  minutes without any answer.
- **Garbage collection.** `collectBlobGarbage` keeps every blob reachable from a live reference
  (the blob, its manifest and its chunks) and deletes the rest, sparing unreferenced blobs written
  within a grace period (default 24 hours): a device uploads bytes before the record that points
  at them, and that record can arrive much later.

## Key choices

- **Per-top-level-key, not recursive, map merge**: covers the concurrent-edit case that matters
  (different keys) with a fold that is easy to prove and to redact.
- **Secrets transformed at write time** rather than encrypted in transit only: the operation log
  is durable and replicated, so it must never hold plaintext.
- **Blobs as references plus a chunk channel** rather than inline bytes: the log stays small,
  transfer is deduplicated and resumable at chunk granularity, and a peer never re-downloads
  content it has.

## Known limits

- Concurrent edits inside one top-level key of an object or json value resolve by
  last-write-wins on that key.
- A hashed secret cannot be read back, by design; an encrypted secret is readable by anyone who
  holds the app's encryption key.
- Blob bytes are fetched on demand: a device has a file offline only after `pull` fetched it, or
  when an `app.offline.keep(query, { files: true })` pin fetched the files its records reference
  in the background (`docs/guide/offline-readiness.md`).
- There is no inline fast path for tiny blobs: every blob goes through the store and the chunk
  channel.

## Tests

- Fold properties (commutativity, idempotency, order independence) for every field kind,
  including key maps: `packages/core/src/fold/fold.property.test.ts`, `fold.test.ts`,
  `fold-canonical-values.test.ts`, `fold-prototype-keys.test.ts`.
- Secrets: `packages/core/src/secret/secret-crypto.test.ts`, `secret-transform.test.ts`.
- Blobs: `packages/core/src/blob/blob-ref.test.ts` and `packages/store/src/blob/*.test.ts`
  (store backends, chunk transport, manifest transfer, garbage collection, durability),
  `packages/sync/src/blob/blob-chunk-channel.test.ts`.

# Design: Structured, Secret, and Binary Field Types

Status: state-of-the-art target (no phasing; each type is built to its complete form)
Scope: `@korajs/core` field system, with changes across `@korajs/merge`, `@korajs/store`, `@korajs/sync`, `@korajs/devtools`
Bar: these three field types are a differentiating moat. The structured-data CRDT and the content-addressed blob channel are the parts a large engineering org evaluating offline-first frameworks would judge us on. They are built complete, correct, and property-tested, not stubbed.

---

## 1. Where the field system stands today (grounding)

- `FieldKind` (core `types.ts`): `string | number | boolean | timestamp | richtext | enum | array`.
- Merge dispatch (`merge/engine/field-merger.ts`, `autoMerge`): scalar kinds resolve by LWW, `array` by add-wins set, `richtext` by Yjs CRDT. `autoMerge` receives `baseValue`, `localValue`, `remoteValue`, and both operations' HLC timestamps, so a 3-way convergent merge has everything it needs.
- Storage maps kinds to SQL columns: string→TEXT, number→REAL, boolean→INTEGER, enum→TEXT+CHECK, timestamp→INTEGER, array→TEXT (JSON), richtext→BLOB (Yjs state).
- Binary already crosses the whole system: `richtext` values are `Uint8Array`, tagged as canonical JSON in `op.data`, and travel over the protobuf wire as bytes. "A field kind whose value is binary" is a solved plumbing pattern.
- Crypto already exists in `@korajs/auth` (`generateEncryptionKey`, `encryptData`, `decryptData`, key derivation, an `operation-encryptor` for end-to-end operation encryption). `@korajs/core` cannot depend on `@korajs/auth`, so field-level crypto primitives move into core.

---

## 2. Structured data: `object` and `json` as a convergent CRDT

### The bar
Not opaque LWW. Two devices editing different keys of the same settings object offline must both survive on reconnect. That is the whole reason to use an offline-first framework, and getting it wrong on structured data is disqualifying.

### Design: recursive 3-way LWW-map with add-wins key presence
- `t.object({ ...nested field schema })`: a structured value. Each key merges by its declared nested kind (scalars LWW, nested arrays add-wins, nested objects recurse, nested richtext via Yjs).
- `t.json<T>()`: dynamic-key structured value with the same convergent semantics, resolved structurally (a value that is a plain object recurses as a map, an array merges add-wins, anything else is a scalar leaf under LWW).

Merge algorithm, per key, given local, remote, and base:
- Classify each side's action against base: wrote (added or changed), removed (present in base, absent now), or unchanged.
- unchanged + unchanged → base value.
- wrote + unchanged (either side) → the written value.
- removed + unchanged → absent.
- wrote + wrote → recurse if both are maps; add-wins if both arrays; otherwise LWW by the two operations' HLC timestamps (the existing total order, `nodeId` breaking ties).
- wrote + removed → **add-wins**: the write survives. Chosen deliberately: it never silently drops a concurrent edit, matching the array strategy and the "never lose data" principle.
- removed + removed → absent.

This is an Observed-Remove-flavored LWW map. It is commutative (swapping local/remote also swaps the HLCs, and HLC compare is a symmetric total order), idempotent (`merge(a,a,a) = a`), and deterministic (fixed inputs, fixed output). These are proven with fast-check property tests alongside the existing merge proofs, per the testing rules.

### Storage, wire, validation
Storage: TEXT (JSON), like `array`. Wire: JSON, no new encoding. Validation: `t.object` validates against its nested schema at write time; `t.json<T>()` carries compile-time `T` and an optional runtime validator. DevTools: object merges emit a `MergeTrace` per resolved sub-path so a conflict inside a nested object is still inspectable.

### Migration
A `string`-to-`object`/`json` transform so an app already storing `JSON.stringify`'d blobs in a string field adopts the CRDT without a manual data rewrite.

---

## 3. `secret`: field-level encryption plus mandatory redaction

### The bar
A serious framework encrypts secret fields end to end and never leaks them into logs, traces, or DevTools. "It does not sync" is not the state of the art; controlled, encrypted sync is.

### Design
Three properties, all delivered:

1. **Redaction (security-critical).** A `secret` field's value is redacted everywhere the merge engine or event stream exposes values: `MergeTrace.inputA/inputB/base/output`, the `merge:*` and `operation:*` `KoraEvent`s, and the DevTools operation log. Redaction happens where the trace is constructed in `field-merger.ts`, keyed off `kind === 'secret'`, so no path leaks. This lands early (during the CRDT trace work) because it closes an active plaintext leak.
2. **At rest, two sub-kinds.** `t.secret().hashed()` for one-way values (passwords: verify, never read back) and `t.secret().encrypted()` for reversible values (tokens: read back to use). Encryption is AES-GCM via WebCrypto primitives lifted into `@korajs/core` so a `secret` field is self-contained; `@korajs/auth` composes higher-level key management on top.
3. **Encrypted sync.** Secret values sync as ciphertext, riding the operation-encryptor path. Merge is LWW on ciphertext, never on plaintext, and never emits plaintext to a trace.

### Key management
Keys come from a key provider (the same shape `createApp`'s `sync.encryption.key` / `keyProvider` already uses), not hardcoded. A field with no key configured and `.encrypted()` is a schema-validation error at app init, not a silent plaintext write.

---

## 4. `blob` / `attachment`: content-addressed, out-of-band sync

### The bar
Files must not live in the operation log. The log is append-only and only compacted by an explicit process, so a base64 blob is a permanent, re-synced payload that blows past operation-size limits. The state of the art is content addressing plus out-of-band, deduplicated, resumable transfer, which is also what makes large media viable offline.

### Design
- The operation carries a **reference only**: a SHA-256 content hash (the system already hashes for op ids) plus metadata (size, mime type, filename). The reference is a small, LWW value in the log.
- Bytes live in a **content-addressed blob store**, deduplicated by hash (the same file attached twice stores once), with backends per environment (OPFS client-side, filesystem or S3 server-side).
- Transfer is a **dedicated, resumable, chunked channel**, decoupled from the operation stream, content-addressed so a peer never re-requests bytes it already has. Integrity is verified by re-hashing on receipt.
- A small inline fast-path (reusing the richtext binary plumbing) handles tiny blobs below a threshold so avatars and signatures skip the coordination cost.

### Merge, lifecycle
Merge: LWW on the reference hash; a list of attachments is an `array` of references and merges add-wins (two devices attaching different files both survive). Lifecycle: reference-counted garbage collection so a blob is retained while any live record references its hash and reclaimed when none do, coordinated with log compaction.

---

## 5. What every new kind touches

- `@korajs/core`: `FieldKind` union, a `t.*` builder + `FieldBuilder` subclass, `FieldDescriptor` (nested schema for `object`, sub-kind for `secret`, metadata shape for `blob`), schema validation, type inference.
- `@korajs/merge`: `autoMerge` dispatch, the recursive object strategy, and secret redaction in the trace.
- `@korajs/store`: SQL mapping, materialization, binary tagging (blob inline path), and the content-addressed blob store.
- `@korajs/sync`: wire encoding, and the out-of-band blob transfer channel.
- `@korajs/devtools`: `MergeTrace` rendering and honoring secret redaction.
- Migration transforms for each: `string`→`object`/`json`, `string`→`secret`, `string`(base64)→`blob`.

---

## 6. Build sequence (each delivered complete)

Sequenced by where the differentiation is and by dependency, not by "minimum viable first":

1. **`object` / `json` convergent CRDT.** The biggest differentiator and exactly what KoraForms' form definitions and settings need. Establishes the recursive-merge machinery. Delivered with full property-based proofs.
2. **`blob` content-addressed store + out-of-band channel.** The second moat; the real infrastructure project. Includes the inline fast-path.
3. **`secret` field-level encryption.** Redaction lands during step 1's trace work (it is an active leak); the hashed/encrypted-at-rest and encrypted-sync completion follows as its own self-contained unit.

Each step is a complete, property-tested, shippable subsystem before the next begins, so correctness is never deferred behind a stub.

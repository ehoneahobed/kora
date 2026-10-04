---
title: Sync Encryption
description: "Encrypt Kora.js sync traffic end to end: shared per-user keys, unlock and lock, rotation, recovery, and what the sync server can and cannot see."
---

# Sync Encryption

Kora supports end-to-end encryption for sync. When enabled, operation data is encrypted on the client before it leaves the device. The sync server stores and relays encrypted payloads without ever seeing plaintext user data, and it never holds a usable key.

Encryption covers the **sync wire and the server**. It does not encrypt the device's local database: data on the device is as readable as it is without sync encryption.

## What Gets Encrypted

Since protocol v2 (1.0.0-beta.13) an operation's `data`, `previousData` and atomic ops (`increment` amounts and similar) travel only as ciphertext, inside the operation's encryption envelope (`op.encrypted`). On the wire `data` is `null`, or holds only the cleartext scope fields you list (see below). Metadata stays in cleartext:

| Encrypted (in `op.encrypted`) | Not Encrypted |
|-----------|---------------|
| `data` (field values) | `id` (operation ID) |
| `previousData` (previous field values) | `nodeId` (device ID) |
| `atomicOps` (atomic intents) | `collection`, `recordId`, `type` |
| | `timestamp` (HLC timestamp) |
| | `sequenceNumber`, `causalDeps`, `schemaVersion` |
| | fields listed in `cleartextFields` |

The server needs metadata to route operations, deduplicate by content-addressed ID, enforce causal ordering, and compute deltas. A schema-aware server stores an encrypted operation opaquely: it never validates, transforms or reads its fields.

### Cleartext scope fields

A server can only evaluate sync scopes on values it can read. List the scope keys per collection; they travel in cleartext beside the envelope (and stay inside the ciphertext as well, which is the authoritative copy):

<!-- docs-check: skip fragment of the sync.encryption config -->
```typescript
encryption: {
  enabled: true,
  key: passphrase,
  cleartextFields: { todos: ['ownerId'] },
}
```

Values listed here are visible to the server. List only scope keys and the foreign keys below.

### Foreign keys of enforced relations must be cleartext

The sync server enforces a relation's `onDelete` policy (`cascade`, `set-null`, `restrict`) for every device: it is the only replica that sees every child, including children created concurrently on devices that the deleting device has never heard of. It can do that only when it can read the foreign key. So, with encryption enabled, the foreign-key field of every relation whose `onDelete` is `cascade`, `set-null` or `restrict` **must** be listed in `cleartextFields`. `createApp` refuses a configuration that seals one, at startup, with a `SealedRelationFieldError` (`code: 'SEALED_RELATION_FIELD'`) naming the relation, the field and the fix:

<!-- docs-check: skip fragment of the sync.encryption config -->
```typescript
relations: {
  todoProject: { from: 'todos', to: 'projects', type: 'many-to-one', field: 'projectId', onDelete: 'cascade' },
},
// ...
encryption: {
  enabled: true,
  key: passphrase,
  cleartextFields: { todos: ['ownerId', 'projectId'] }, // projectId: the server cascades
}
```

The server then learns which project each todo belongs to, and nothing else about the todo. If that is not acceptable, use `onDelete: 'no-action'` for the relation (its foreign key may stay sealed) and delete the children in your own code.

With the foreign key in cleartext, cascades behave exactly as without encryption: the deleting device authors the effects on the children it holds, the server derives the effects on children it holds and the deleting device did not know (its plaintext cascade and set-null operations touch only cleartext fields, so encrypted devices accept them), and every other device applies a remote delete's effects locally until the real copies arrive.

## Enabling Encryption

Add `encryption` to your sync config:

<!-- docs-check-prelude
import { createApp, defineSchema, t } from 'korajs'
import { createKoraAuth, createKoraAuthSync } from '@korajs/auth'
const schema = defineSchema({ version: 1, collections: { todos: { fields: { title: t.string() } } } })
const authClient = createKoraAuthSync({ authClient: createKoraAuth({ serverUrl: 'https://api.example.com' }), schema })
declare const passphrase: string
declare const newPassphrase: string
declare const currentPassphrase: string
declare function showUnlockPrompt(code: string | undefined): void
-->

```typescript
const app = createApp({
  schema,
  sync: {
    url: 'wss://my-server.com/kora',
    authClient, // one keyring per signed-in user (see "Who can read a key record")
    encryption: { enabled: true },
  },
})

// Later, when the user enters their encryption passphrase:
await app.encryption?.unlock(passphrase)
```

Until the keyring is unlocked, sync is paused (`sync:suspended` with reason `encryption-locked`) and nothing leaves the device. Local reads and writes keep working; writes queue and upload, encrypted, once the keyring is unlocked.

You can also pass the passphrase (or an async provider of it) in the config. The keyring is then opened automatically at the first sync handshake:

<!-- docs-check: skip fragment of the sync.encryption config -->
```typescript
encryption: {
  enabled: true,
  key: async () => await getEncryptionPassphrase(), // called only when the keyring needs it
}
```

The provider is called when a device has no unlocked keys yet (first start, after `lock()`, or after the passphrase changed on another device). It is not called on every start when the keys are cached.

## How Keys Work

Every user has a **keyring**: random 256-bit AES-GCM data keys, one per key version, held together by a random **master key** (the ring's secret). The sync server stores the keyring as one **key record** (format 2), in wrapped form only:

```text
passphrase --PBKDF2-SHA256(salt)--> key-encryption key (KEK)
KEK --AES-256-GCM--> master key
recovery public key --ECDH P-256 + HKDF + AES-GCM--> master key       (optional)
master key --HKDF "data-key-wrap"--> wrapping key --AES-256-GCM--> data key v1, v2, ...
master key --HKDF "record-mac"--> MAC key --HMAC-SHA256--> mac over the whole record
```

| Parameter | Value |
|-----------|-------|
| Key derivation | PBKDF2-SHA256, 600,000 iterations (OWASP) |
| Salt | 32 random bytes, new with every passphrase, stored in the record |
| Master key | 32 random bytes per ring; a new one with every passphrase change |
| Data keys | Random 256-bit AES-GCM keys, one per key version, each with a random key id |
| Key wraps | AES-256-GCM; additional data binds keyring, ring id, key version and key id |
| Record MAC | HMAC-SHA256 over every other field of the record (canonical JSON) |

The record is `{ format, keyring, ringId, revision, currentVersion, kdf, master, keys, recovery?, mac }`. The server never sees the passphrase, the KEK, the master key or a data key, and it cannot unwrap anything.

### What the server can and cannot do to the record

The MAC is keyed from the master key, so **only a holder of the ring** (someone who knows the passphrase or the recovery key, or a device that opened the ring) can write a record that devices accept. A device acts only on records it authenticated: it refuses a record whose MAC does not verify (`KEY_RECORD_INVALID`) and keeps working with the keys it holds. The server therefore cannot add or swap a recovery key, inject, drop or relabel a key version, lower the KDF cost, or serve another body under a revision a device accepted.

What a server (or anyone who controls its database) **can** still do:

- **Withhold or replay records.** Every device pins the ring id and the highest revision it accepted, persisted with its cached keys (a `lock()` keeps the pin). It refuses a lower revision (`KEY_RECORD_ROLLBACK`), keeps its keys, and writes its newer record back at the next sync session. A device that has never seen the newer revision (a fresh install) cannot tell it was rolled back: after a passphrase change, the old passphrase then opens that old revision on a new device. Rotate after a passphrase leak (see below), and treat the server operator as able to replay old records.
- **Try passphrases offline** against a record it holds (see "Wrong passphrases").
- **Refuse service or lose the record** (see "Lost key records").

At each sync handshake the device fetches the record **before any operation is exchanged**, and then:

- On the user's first device (no record, and no encrypted history on the server) it creates the ring (master key, first data key) and stores the record. If two first devices race, the server's compare-and-set lets one win and the other opens the winner's record, so a user never ends up with two rings.
- On every other device it derives the KEK from the passphrase, opens the master key, verifies the record's MAC, unwraps the data keys and caches them locally.

Every device of a user therefore holds the same data keys and decrypts everything the others wrote, including history written before it joined. Operations name their data key by key id, so a device decrypts them whatever version number the key has in the record.

### Where unlocked keys are kept

| `encryption.keyCache` | Where | After a restart |
|---|---|---|
| `'auto'` (default) | IndexedDB in browsers, memory elsewhere (Node, tests) | Browser: unlocked, offline. Node: the configured `key` re-opens the keyring at the next handshake |
| `'indexeddb'` | IndexedDB | Unlocked, offline |
| `'memory'` | Memory | Locked until `key` or `unlock()` |
| `'none'` | Nothing beyond the running keyring | Locked until `key` or `unlock()` |

Cached data keys, the master key's derived keys and the KEK are stored as **non-extractable** `CryptoKey`s: script running in the page can use them, but cannot read their bytes. Anyone who controls the page (an XSS bug, a malicious extension) can still decrypt while the app runs, as with any web E2E scheme. The cache also keeps the last authenticated record (the rollback pin), so with a persistent cache `unlock(passphrase)` works offline on a device that has synced once.

### Lock state

`app.encryption.getStatus()` (and the `encryption:status` event) reports:

| `state` | Meaning |
|---|---|
| `unlocked` | Keys are available; sync runs. `keyVersion`, `keyId` and `availableVersions` are set. With `code: 'PASSPHRASE_REQUIRED'` the passphrase changed on another device: this device keeps encrypting with the keys it holds, and needs the current passphrase for key management. |
| `unlocking` | The record is being fetched or opened. |
| `locked` | No usable keys. `code` says why: `NO_PASSPHRASE`, `AWAITING_SERVER` (a passphrase was given; the record arrives with the next handshake), `LOCKED_BY_APP`, `PASSPHRASE_REQUIRED` (another device changed the passphrase and this device needs a key it does not hold yet), `KEY_RECORD_MISSING` (the server lost the record; see below), `KEY_RING_FORK` (the server holds another ring; enter the passphrase to merge). |
| `error` | `WRONG_PASSPHRASE`, `KEY_RECORD_INVALID` (the server's record does not authenticate or is malformed), `KEY_RECORD_ROLLBACK` (an older revision than this device accepted), `KEY_RING_FORK`, `KEY_SERVICE_FORBIDDEN`, `KEY_SERVICE_UNSUPPORTED`, `RECOVERY_FAILED`. |

`KEY_RECORD_INVALID`, `KEY_RECORD_ROLLBACK`, `KEY_RECORD_MISSING` and `KEY_RING_FORK` are conditions of the server's record, not of the user: a device that holds keys keeps them, sync reconnects with backoff, and the next session re-uploads, merges or opens the record without user action where it can. The other codes pause sync until `unlock()` succeeds.

<!-- docs-check: continue -->
```typescript
app.encryption?.onStatusChange((status) => {
  if (status.state !== 'unlocked') showUnlockPrompt(status.code)
})

await app.encryption?.lock() // forget the keys on this device (and its cache); sync stops
```

Once unlocked, the keyring needs no server: a device keeps encrypting and decrypting offline, and its queued writes upload when it reconnects.

**Wrong passphrases.** The server cannot check a passphrase (it never sees one). `unlock()` rejects a wrong passphrase with `WRONG_PASSPHRASE`, and after three failures on a device it backs off (1 s, 2 s, 4 s, ... up to 60 s; `UNLOCK_THROTTLED` with `retryAfterMs`). This is a usability guard, not a security boundary: whoever obtains the wrapped record (the server operator, or anyone who can read its database) can try passphrases offline at PBKDF2 speed. Passphrase strength is the protection. Ask for a long passphrase.

## Key Rotation and Passphrase Changes

Both need a live sync connection (they write the key record with compare-and-set):

<!-- docs-check: continue -->
```typescript
// A new data key for new operations. Old versions stay in the record, so history
// still decrypts on every device, including devices that join later.
await app.encryption?.rotateKey()

// A new master key under a new passphrase; every data key is re-wrapped under it.
// No operation is re-encrypted.
await app.encryption?.changePassphrase(newPassphrase, { currentPassphrase })
```

- **Rotation.** The server pushes the new record to the user's other connected devices before any operation sealed under the new version reaches them. A device that receives such an operation without the push (another server instance) fetches the record once and replays it. Rotation limits what a leaked data key exposes from now on; it does not re-encrypt old operations.
- **Passphrase change.** The ring gets a new master key, sealed under the new passphrase: the old passphrase (and the old master key it opened) can neither open nor authenticate any later record. Other devices keep working with the data keys they hold (`unlocked` with `PASSPHRASE_REQUIRED`). A device that later needs a key it does not hold (for example after a rotation following the passphrase change) asks for the new passphrase. **After a suspected leak, change the passphrase and then rotate**: the data keys the old passphrase could open stay what they were, and only a rotation gives new operations a key the leaked passphrase never reached.
- **Concurrent key management.** Every compare-and-set retry adopts and authenticates the server's current record first and writes under that record's own master key, so a rotation that races a passphrase change on another device never wraps a key under the old passphrase. A device that cannot authenticate the newer record (the passphrase changed elsewhere) stops with `PASSPHRASE_REQUIRED` instead of writing.
- A record never loses a key version: the server refuses writes that lower the revision, change the ring id, or drop or relabel a version, and a device refuses a record that lacks a key it holds.

## Lost Passphrase and the Recovery Key

**Without a recovery key, a lost passphrase means the encrypted data cannot be recovered**, by you or by the server operator. Devices that are still unlocked keep working (and can set a new passphrase with `changePassphrase`), but once no device holds the keys, the data on the server is unreadable. This is inherent to end-to-end encryption.

To offer recovery, create a recovery key while the keyring is unlocked with the **current** passphrase and show it to the user once:

<!-- docs-check: continue -->
```typescript
const recoveryKey = await app.encryption?.enableRecovery() // "kora-rk2-<key>.<anchor>"; store it offline
// ...later, on any device, after the passphrase was lost:
if (recoveryKey) await app.encryption?.recover(recoveryKey, newPassphrase)
```

The ring's master key is also wrapped to the recovery key's public half (ephemeral-static ECDH P-256, HKDF-SHA256, AES-256-GCM). Rotation needs no change to it (data keys hang off the master key), and a passphrase change re-wraps the new master key to the same public key, so the recovery key stays valid. The recovery key itself is never sent to the server. Calling `enableRecovery()` again replaces it.

A recovery key also carries a **ring anchor**: a fingerprint of the ring's first data key. The recovery public key is stored on the server, so anyone could wrap a master key of their own to it and offer a whole substitute ring; `recover()` refuses a record that does not hold the anchored data key (`KEY_RECORD_INVALID`), so a recovering device never adopts keys the server chose. Recovery verifies the record's MAC under the recovered master key, keeps the master key (devices holding the ring keep managing it without a prompt), and seals it under the new passphrase.

## Lost Key Records and Forked Keyrings

A server that loses a key record (a database restored without its key table, an operator error) still stores the operations encrypted under it. With no record, the key service reports the key ids of the owner's stored encrypted operations, and:

- **A device that holds the ring** uploads its record again, unchanged (same revision and MAC), so every device's pin accepts it.
- **A new device** (fresh install, passphrase typed) does not start a new ring while that history exists: it stays `locked` with `KEY_RECORD_MISSING` and keeps the passphrase, until a device holding the ring reconnects and re-uploads it. It then opens the ring as usual.
- If no device holding the ring will ever return, the user can start over explicitly. History encrypted under the lost ring stays unreadable:

<!-- docs-check: continue -->
```typescript
// Only for KEY_RECORD_MISSING: rejects with KEY_RECORD_EXISTS when the server holds a record.
await app.encryption?.startNewKeyring()
```

If two rings exist anyway (`startNewKeyring()` was used and an old device returns later, or a server without the history report let a new device create one), the first device that holds keys of both **merges** them: the server's ring survives, the other ring's data keys are re-wrapped into it as new versions (they keep their key ids, so every operation stays readable), and the result is written with compare-and-set. A device that holds keys the server's ring lacks never drops them; without the passphrase it reports `KEY_RING_FORK` until `unlock()`. A recovery key made for the ring that was merged into the other one stops opening it: call `enableRecovery()` again after a merge.

## Who Can Read a Key Record

- **With authentication**, records are per authenticated user: a session reads and writes only its own user's record. Key messages never name a user, so one user cannot fetch or overwrite another's record. An anonymous principal (`MixedAuthProvider` fallback) gets `KEY_SERVICE_FORBIDDEN`.
- **Without authentication** (no `auth` on the server, or `NoAuthProvider`), every client shares one data space, so they share one keyring. Anyone who can reach the server can fetch its wrapped record and try passphrases offline.
- Use a separate `encryption.keyring` name per encryption scope. Different keyrings have different keys; a device decrypts only the keyrings it has opened.

## Server Requirements

- The key service ships in `@korajs/server` 1.0.0-beta.13 and needs protocol v2. Against an older server the keyring reports `KEY_SERVICE_UNSUPPORTED`.
- The memory, SQLite and Postgres server stores persist key records (table `kora_encryption_keys`). A custom `ServerStore` implements `getEncryptionKeyRecord` and `putEncryptionKeyRecord` (compare-and-set); without them the server answers `unsupported` rather than keeping records in memory, which would give users a new key after every restart. It should also implement `getEncryptedKeyIds` (the history report that keeps a new device from starting a second ring) and `listEncryptionKeyRecords` (backups).
- The server store's `exportBackup()` includes the key records (section `encryption_keys`), and `importBackup()` restores the ones the store lacks, in both modes; it never replaces a record the store holds. A backup with a malformed key record is refused whole (`BACKUP_INVALID_KEY_RECORD`). If you back up the database by other means, include `kora_encryption_keys`.
- The server validates a record's structure and the write rule (revision grows, ring id and every key version kept) but cannot check the MAC; devices do.

## Encryption Algorithm

Each envelope member (`data`, `previousData`, `atomicOps`) is encrypted with AES-256-GCM under the current data key and a fresh random 12-byte IV (NIST SP 800-38D). `data` and `previousData` are sealed even when they are `null`, so a delete is authenticated too.

**Binding (ENC-3).** Every ciphertext is authenticated with AES-GCM additional data: the canonical JSON of `(nodeId, collection, recordId, type, timestamp, sequenceNumber, field, keyVersion, hashVersion)`. A ciphertext moved to another operation, record or member, or an envelope whose metadata was rewritten, fails authentication and the operation is quarantined (`DECRYPT_FAILED`). The operation id is the version-2 content hash of the **plaintext**; the receiving client verifies it after decryption, which covers `causalDeps` and `schemaVersion` as well (`INVALID_OPERATION_ID`).

The envelope (protocol v2) looks like this on the wire:

```json
{
  "data": null,
  "hashVersion": 2,
  "encrypted": {
    "v": 2,
    "alg": "aes-256-gcm",
    "keyId": "k2-5d0c1e9a7b3f42c68e1d0a9b7c6f5e4d",
    "keyVersion": 1,
    "data": { "iv": "base64-12-byte-iv", "ct": "base64-ciphertext-and-tag" },
    "previousData": { "iv": "...", "ct": "..." },
    "atomicOps": { "iv": "...", "ct": "..." }
  }
}
```

`keyId` selects the data key: it is the key's random id from the key record (never derived from key material), and it stays the same when a merged ring gives the key another version number. `keyVersion` is the version the writer used (bound into the additional data). A device that does not hold the key fetches the record once; a device holding a different keyring reports `KEY_ID_MISMATCH` instead of a bare authentication failure. Such an operation is quarantined, not lost, and decrypts once the right keys are available.

## Low-Level API

`SyncEncryptor` remains available for custom setups (`@korajs/sync`). `SyncEncryptor.fromKeys([{ version, key, keyId }])` builds an encryptor from keys you manage yourself. `SyncEncryptor.create(config, salt)` derives a key directly from a passphrase and **requires** the salt: every device must pass the same one. There is no random-salt default any more (a per-process random salt is why encryption in 1.0.0-beta.12 could not work across devices). `EncryptionKeyring` is the class behind `app.encryption`, for apps that drive `SyncEngine` directly (`new SyncEngine({ ..., keyring })`).

## Plaintext and Older Payloads

With encryption enabled, an inbound operation without an envelope is **refused** and quarantined: anyone who can reach the sync server could have written it, so applying it would let the server inject unauthenticated writes. One exception: the server's own operations (from a node the handshake names authoritative: cascades and set-nulls of a deleted parent, constraint corrections, route writes) are accepted in plaintext when they touch only the collection's `cleartextFields` (a delete carries no fields). The server holds no key, so it cannot seal them, and they carry nothing the server cannot already read. A server write to a sealed field is still refused. Protocol-1 payloads (ciphertext inside `data`, written by Kora <= 1.0.0-beta.12, not bound to their operation) are refused the same way (`LEGACY_ENCRYPTED_PAYLOAD`).

To migrate an existing plaintext app to encryption, open a migration window:

<!-- docs-check: skip fragment of the sync.encryption config -->
```typescript
encryption: { enabled: true, key: passphrase, allowPlaintextMigration: true }
```

During the window, plaintext operations are applied as before. Close it once every device has upgraded and re-synced. A server can enforce the same rule for uploads with `createKoraServer({ encryption: { required: true } })` (`PLAINTEXT_REJECTED`, with the same `allowPlaintextMigration` escape hatch).

## Migrating from 1.0.0-beta.12 Encryption

In beta.12, `createApp` derived the key from the passphrase with a random salt in every process, and never stored it. Encrypted data was therefore never readable on another device, nor on the same device after a reload. What that means now:

- **On the device that wrote it**, the data is still in its local database in plaintext (sync encryption never encrypted local storage). It stays readable there.
- **On the server**, those operations are protocol-1 payloads under a key that no longer exists anywhere. They cannot be decrypted by anyone, and every beta.13 device refuses them (`LEGACY_ENCRYPTED_PAYLOAD`, quarantined).
- **To share such records** with other devices, write them again from a device that has them (for example, copy each one into a new record). There is no automatic re-encryption: the old ciphertext cannot be opened.

New data is encrypted under the user's keyring from the first beta.13 handshake on.

Encrypted beta.12 (protocol 1) clients cannot sync with a server of this release: their uploads are refused terminally (`PLAINTEXT_REJECTED` when the server requires encryption, `SCHEMA_VALIDATION_ERROR` otherwise; `allowPlaintextMigration` admits plaintext only, never protocol-1 ciphertext), as a schema-aware beta.12 server already refused them. Writes refused that way stay on the device after it upgrades; they are not uploaded again.

## Performance Considerations

- **Key derivation is slow by design**: PBKDF2 with 600,000 iterations takes roughly 200-500 ms depending on the device. It runs when a device opens the keyring with a passphrase (first unlock, a passphrase change, recovery), not on every start when keys are cached, and never per operation.
- **Per-operation encryption is fast**: AES-256-GCM runs in hardware on modern devices. Encrypting a typical operation's data takes under 1 ms.
- **Batch operations**: batches are encrypted in parallel.
- **Payload size increase**: the IV (12 bytes), GCM tag (16 bytes) and base64 (~33%) per envelope member. For most applications this is negligible.
- **Web Crypto API required**: encryption uses `crypto.subtle` (browsers in a secure context, Node.js 20+).
- `encryption.kdfIterations` lowers the PBKDF2 cost for tests only. A device refuses a key record with fewer iterations than its own setting, so a server cannot downgrade the KDF.

## Error Handling

- **`EncryptionKeyError`** (from `app.encryption` calls): `context.code` names the reason (`WRONG_PASSPHRASE`, `UNLOCK_THROTTLED`, `PASSPHRASE_REQUIRED`, `KEY_RECORD_CONFLICT`, `KEY_RECORD_INVALID`, `KEY_RECORD_ROLLBACK`, `KEY_RECORD_MISSING`, `KEY_RECORD_EXISTS`, `KEY_SERVICE_OFFLINE`, `KEY_SERVICE_UNSUPPORTED`, `NO_RECOVERY_KEY`, ...). `recover()` rejects a malformed or foreign recovery key with `WRONG_RECOVERY_KEY`.
- **`DecryptionError`** on an inbound operation does not end the session: the operation is quarantined (`DECRYPT_FAILED`, `sync:apply-failed`) and retried when new keys arrive. Common causes: an operation from another keyring (`KEY_ID_MISMATCH`), tampered ciphertext, a key version this device does not hold yet, a plaintext operation (`PLAINTEXT_REJECTED`).
- **`EncryptionError`** when sealing fails (no `crypto.subtle`). Nothing is sent; the batch stays queued.

All errors carry context fields (`operationId`, `keyVersion`, `keyId`, `code`) to diagnose without reproduction.

## Limitations

- **Server cannot query encrypted fields**: the server sees only ciphertext, so server-side filtering or indexing of encrypted field values is not possible. Sync scoping works on metadata and `cleartextFields`.
- **Key loss is data loss** unless a recovery key was set up (see above).
- **Local data is not encrypted** by this feature; protect the device.
- **Key management needs the server**: rotation, passphrase changes and recovery write the key record. Everyday encryption, decryption and `unlock()` with a cached record work offline.
- **Rollback detection needs history**: a device refuses key-record revisions older than one it accepted, but a new device trusts the newest revision the server shows it. A server that kept an old revision can serve it to a new device, where the passphrase of that revision opens it.
- **Encrypted operations are not schema-transformed by the server**: the server cannot read them, so a client on an older schema version transforms them after decryption.
- **Server stores persist the envelope**: memory, SQLite and Postgres server stores keep `op.encrypted` verbatim (1.0.0-beta.13 or later on the server).
- **Server-side rules see only cleartext fields**: referential policies (cascade, set-null, restrict) are enforced on the server, so their foreign keys must be cleartext (see above; a sealed one is refused at startup). A server scope entry (the synthesized insert that brings a record into a device's scope) cannot restate sealed values, so an encrypted device quarantines it; with encryption, sync whole scopes from the start rather than relying on scope changes.

---
title: Sync Encryption
description: "Encrypt Kora.js sync traffic end to end: encryption hooks, key management, and what the sync server can and cannot see."
---

# Sync Encryption

Kora supports end-to-end encryption for sync. When enabled, operation data is encrypted on the client before it leaves the device. The sync server stores and relays encrypted payloads without ever seeing plaintext user data.

## What Gets Encrypted

Since protocol v2 (beta.14) an operation's `data`, `previousData` and atomic ops (`increment` amounts and similar) travel only as ciphertext, inside the operation's encryption envelope (`op.encrypted`). On the wire `data` is `null`, or holds only the cleartext scope fields you list (see below). Metadata stays in cleartext:

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

```typescript
encryption: {
  enabled: true,
  key: passphrase,
  cleartextFields: { todos: ['ownerId'] },
}
```

Values listed here are visible to the server. List only scope keys.

## Enabling Encryption

Add `encryption` to your sync config:

```typescript
import { createApp } from 'korajs'
import schema from './schema'

const app = createApp({
  schema,
  sync: {
    url: 'wss://my-server.com/kora',
    encryption: {
      enabled: true,
      key: 'my-secure-passphrase',
    },
  },
})
```

That is all. Operations are encrypted before sending and decrypted after receiving, transparently.

### Using a Key Provider Function

Instead of a static passphrase, you can provide an async function. This is useful when the passphrase comes from a user prompt, a vault, or a key management service:

```typescript
sync: {
  url: 'wss://my-server.com/kora',
  encryption: {
    enabled: true,
    key: async () => {
      // Fetch from a vault, prompt the user, etc.
      return await getEncryptionPassphrase()
    },
  },
}
```

The key provider is called once during initialization. The derived key is held in memory for the lifetime of the app instance.

## How Key Derivation Works

Kora derives encryption keys from passphrases using PBKDF2 (Password-Based Key Derivation Function 2) with the following parameters:

| Parameter | Value |
|-----------|-------|
| Algorithm | PBKDF2 |
| Hash | SHA-256 |
| Iterations | 600,000 (OWASP recommended minimum) |
| Salt | 32 bytes, randomly generated |
| Derived key | AES-256-GCM (256-bit) |

The high iteration count makes brute-force attacks against weak passphrases computationally expensive. The random salt ensures that the same passphrase on different devices produces different derived keys (unless the salt is shared).

### Salt Management

When a key is first derived, a random 32-byte salt is generated. This salt must be shared with all devices that need to decrypt the data. Kora handles this automatically through the versioned key system -- the salt is stored alongside the key version.

## Encryption Algorithm

Each envelope member (`data`, `previousData`, `atomicOps`) is encrypted with AES-256-GCM and a fresh random 12-byte IV (NIST SP 800-38D). `data` and `previousData` are sealed even when they are `null`, so a delete is authenticated too.

**Binding (ENC-3).** Every ciphertext is authenticated with AES-GCM additional data: the canonical JSON of `(nodeId, collection, recordId, type, timestamp, sequenceNumber, field, keyVersion, hashVersion)`. A ciphertext moved to another operation, record or member, or an envelope whose metadata was rewritten, fails authentication and the operation is quarantined (`DECRYPT_FAILED`). The operation id is the version-2 content hash of the **plaintext**; the receiving client verifies it after decryption, which covers `causalDeps` and `schemaVersion` as well (`INVALID_OPERATION_ID`).

The envelope (protocol v2) looks like this on the wire:

```json
{
  "data": null,
  "hashVersion": 2,
  "encrypted": {
    "v": 2,
    "alg": "aes-256-gcm",
    "keyId": "k1-3fa9c1d2e4b5a6f7",
    "keyVersion": 1,
    "data": { "iv": "base64-12-byte-iv", "ct": "base64-ciphertext-and-tag" },
    "previousData": { "iv": "...", "ct": "..." },
    "atomicOps": { "iv": "...", "ct": "..." }
  }
}
```

`keyVersion` selects the key (rotation). `keyId` names the key material (a fingerprint of the key-derivation salt, never the key), so a device holding different material reports `KEY_ID_MISMATCH` instead of a bare authentication failure.

## Key Rotation

When you need to change the encryption passphrase (user changes password, security policy, key compromise), Kora supports key rotation through versioned keys.

### How It Works

1. The old key (version 1) continues to be available for decrypting previously encrypted operations.
2. A new key (version 2) is derived from the new passphrase.
3. All new operations are encrypted with the latest key version.
4. The key version is embedded in each encrypted payload, so the decryptor selects the correct key automatically.

### Using Versioned Keys

For advanced key rotation, create a `SyncEncryptor` with multiple key versions:

```typescript
import { SyncEncryptor, deriveVersionedKey } from '@korajs/sync'

// Derive keys from old and new passphrases
const oldKey = await deriveVersionedKey('old-passphrase', 1, savedSaltV1)
const newKey = await deriveVersionedKey('new-passphrase', 2)

// Create encryptor with both keys
const encryptor = SyncEncryptor.fromKeys([oldKey, newKey])

// New operations encrypt with version 2
// Old operations (version 1) can still be decrypted
```

The encryptor always encrypts with the highest version key. All registered key versions remain available for decryption.

### Adding Keys at Runtime

You can also add keys after creation:

```typescript
const encryptor = await SyncEncryptor.create({
  enabled: true,
  key: 'original-passphrase',
})

// Later, rotate to a new key
const newKey = await deriveVersionedKey('new-passphrase', 2)
encryptor.addKey(newKey)

// Now encrypts with version 2, can still decrypt version 1
```

## Plaintext and Older Payloads

With encryption enabled, an inbound operation without an envelope is **refused** and quarantined: anyone who can reach the sync server could have written it, so applying it would let the server inject unauthenticated writes. Protocol-1 payloads (ciphertext inside `data`, written by Kora <= beta.13, not bound to their operation) are refused the same way.

To migrate an existing plaintext app to encryption, open a migration window:

```typescript
encryption: { enabled: true, key: passphrase, allowPlaintextMigration: true }
```

During the window, plaintext operations are applied as before. Close it once every device has upgraded and re-synced. A server can enforce the same rule for uploads with `createKoraServer({ encryption: { required: true } })` (`PLAINTEXT_REJECTED`, with the same `allowPlaintextMigration` escape hatch).

## Performance Considerations

Encryption adds overhead to every sync operation. Key factors to consider:

- **Key derivation is slow by design**: PBKDF2 with 600,000 iterations takes roughly 200-500ms depending on the device. This happens once at app startup, not on every operation.
- **Per-operation encryption is fast**: AES-256-GCM runs in hardware on modern devices. Encrypting a typical operation's data takes under 1ms.
- **Batch operations**: `encryptBatch()` and `decryptBatch()` process operations in parallel using `Promise.all`, so batches of 100 operations complete in roughly the same time as a single operation.
- **Payload size increase**: Encrypted payloads are larger than plaintext due to the IV (12 bytes), GCM authentication tag (16 bytes), and base64 encoding (~33% overhead). For most applications, this is negligible.
- **Web Crypto API required**: Encryption uses `crypto.subtle`, which is available in all modern browsers and Node.js 20+. It is not available in older environments or some non-browser runtimes.

## Error Handling

Encryption and decryption errors are specific and actionable:

- **`EncryptionError`**: Thrown when encryption fails. Typically indicates that `crypto.subtle` is unavailable or the key is invalid.
- **`DecryptionError`**: Thrown when decryption fails. Common causes:
  - Wrong passphrase (key mismatch)
  - Tampered or corrupted ciphertext
  - Missing key version (data encrypted with a rotated key that was not registered)
  - Unsupported algorithm

All errors include context fields (`operationId`, `fieldName`, `keyVersion`) to help diagnose the issue without reproduction.

## Example: Full Setup with User Passphrase

A common pattern is to derive the encryption key from the user's password or a dedicated encryption passphrase:

```typescript
import { createApp } from 'korajs'
import schema from './schema'

async function initApp(userPassphrase: string) {
  const app = createApp({
    schema,
    sync: {
      url: 'wss://my-server.com/kora',
      auth: async () => ({ token: await getAuthToken() }),
      encryption: {
        enabled: true,
        key: userPassphrase,
      },
    },
  })

  await app.ready
  await app.sync?.connect()

  return app
}

// At login time:
const passphrase = await promptUserForEncryptionKey()
const app = await initApp(passphrase)
```

With this setup:

- All operation data is encrypted before leaving the device.
- The sync server stores only encrypted blobs for `data` and `previousData`.
- Other authenticated devices with the same passphrase can decrypt and read the data.
- No one with server access alone can read the plaintext field values.

## Limitations

- **Server cannot query encrypted fields**: Since the server sees only ciphertext, server-side filtering or indexing of encrypted field values is not possible. Sync scoping works on metadata (collection names, scope fields in cleartext) rather than encrypted content.
- **Key loss is data loss**: If all devices lose the encryption key and no backup exists, encrypted operations cannot be recovered. There is no server-side recovery mechanism -- this is inherent to end-to-end encryption.
- **All clients must share keys**: Every device that needs to decrypt operations must have the correct key version registered. Key distribution is the application's responsibility.
- **Key material is per device until Phase 4 (ENC-1)**: `createApp` derives the key with a random salt per process, so two devices with the same passphrase do not yet derive the same key. Decryption then fails with `KEY_ID_MISMATCH` (the envelope's `keyId` names the material) and the operation is quarantined, not lost. Until shared key material ships, construct the encryptor with a shared salt (`SyncEncryptor.create(config, salt)`) or `SyncEncryptor.fromKeys`.
- **Encrypted operations are not schema-transformed by the server**: the server cannot read them, so a client on an older schema version transforms them after decryption.
- **Server stores must persist the envelope**: the in-memory server store keeps `op.encrypted`; check your server version's release notes before running encrypted sync on the SQLite or Postgres store.

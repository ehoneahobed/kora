# Sync Encryption

Kora supports end-to-end encryption for sync. When enabled, operation data is encrypted on the client before it leaves the device. The sync server stores and relays encrypted payloads without ever seeing plaintext user data.

## What Gets Encrypted

Only the `data` and `previousData` fields of each operation are encrypted. Metadata stays in cleartext:

| Encrypted | Not Encrypted |
|-----------|---------------|
| `data` (field values) | `id` (operation ID) |
| `previousData` (previous field values) | `nodeId` (device ID) |
| | `collection` (collection name) |
| | `timestamp` (HLC timestamp) |
| | `sequenceNumber` |
| | `causalDeps` (dependency IDs) |
| | `type` (insert/update/delete) |

This design is intentional. The server needs metadata to route operations, deduplicate by content-addressed ID, enforce causal ordering, and compute version vector deltas. But the actual user data -- the field values your application writes -- is opaque to the server.

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

Each field encryption uses AES-256-GCM with a fresh random 12-byte initialization vector (IV). This is the NIST-recommended configuration (SP 800-38D). Key properties:

- **Authenticated encryption**: AES-GCM provides both confidentiality and integrity. Tampered ciphertext is detected and rejected during decryption.
- **Unique IVs**: Every field encryption generates a new random IV. Encrypting the same data twice produces different ciphertext.
- **Per-field encryption**: `data` and `previousData` are encrypted independently, each with their own IV.

The encrypted payload stored on the wire looks like this:

```json
{
  "__kora_e2e_encrypted": true,
  "v": 1,
  "iv": "base64-encoded-12-byte-iv",
  "ct": "base64-encoded-ciphertext",
  "alg": "aes-256-gcm"
}
```

The `v` field identifies the key version, enabling key rotation.

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

## Backward Compatibility

The encryption system handles mixed plaintext and encrypted operations gracefully. If a field value does not contain the encrypted marker (`__kora_e2e_encrypted`), it passes through decryption unchanged. This means:

- You can enable encryption on an existing app. Old unencrypted operations remain readable.
- During a transition period, some operations may be encrypted and others not.
- The system never fails on unencrypted data -- it simply passes through.

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

---
"@korajs/core": minor
"@korajs/merge": minor
---

Add a `secret` field type with mandatory trace redaction and field-level cryptography (security core).

Secrets (passwords, tokens, API keys) get first-class handling instead of living in plain `string` fields that leak into logs and DevTools.

- `t.secret()` fields choose their at-rest protection with `.hashed()` (one-way, for passwords) or `.encrypted()` (reversible, for tokens); the default is `encrypted`. On input the value is a plaintext string; the framework applies the transform.
- Merge traces redact secret fields. A secret's value never appears in a `MergeTrace` — not in `inputA`/`inputB`/`base`/`output`, and not inside the embedded `operationA`/`operationB` (whose `data`/`previousData` are redacted too). This closes a real leak where plaintext secrets appeared in DevTools, logs, and audit exports. Non-secret fields are unaffected.
- `@korajs/core` exposes the field-level crypto primitives (standard WebCrypto, no `@korajs/auth` dependency): `encryptSecret` / `decryptSecret` (AES-256-GCM with a per-value random salt and IV, wrong-key decryption fails), and `hashSecret` / `verifySecret` (PBKDF2-SHA-256, salted, one-way, constant-time verification).

Secret values merge by last-write-wins on the stored representation (ciphertext or hash), never on plaintext. The write-time transform wiring (apply the hash/encrypt on write via a key provider, decrypt on read) is the remaining integration step; these primitives and the redaction are the security core it builds on.

---
'@korajs/server': patch
---

Restore the warning for signed-in servers that share every user's data (F4). beta.13 judged the
provider's raw grant, and the built-in provider always returns a claims grant, so the warning never
fired even when no schema sync rule bound it and every collection was granted whole. The server now
judges the resolved grant. New `unscopedSharing` option: `'warn'` (default, once per provider),
`'allow'` (silence it for apps whose users share one data set) or `'refuse'` (refuse the handshake
with `UNSCOPED_SHARING_REFUSED`).

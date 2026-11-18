---
'@korajs/server': patch
---

`trustProxy: 0`, a negative count or `trustProxy: []` in `createProductionServer` now count as unset, as `KORA_TRUST_PROXY=0` already did. Before, the server treated the socket address as a real client address, so every client behind a proxy shared one per-address slot and sign-in failure bucket. It also skipped the warning that per-address protection is off. The server now warns at start, and the host's `KORA_TRUST_PROXY` doesn't replace the app's explicit choice.

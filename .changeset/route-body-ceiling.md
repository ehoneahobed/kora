---
'@korajs/server': patch
---

The deadline for a custom route body now grows with `maxRequestBodyBytes`. It's long enough for the largest allowed body to arrive at 16 KiB/s after a 2 s grace, and never under 30 s, so 66 s at the 1 MiB default. Before, it was a flat 30 s, which a client on a 2G link couldn't meet near the limit. The new `routeBodyTimeoutMs` option sets it explicitly. The minimum-rate rule for small bodies is unchanged, and the docs now say that a chunked body gets the whole time with no rate check.

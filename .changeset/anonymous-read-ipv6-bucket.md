---
'@korajs/server': patch
---

Anonymous read rate limits are now keyed on the client's address bucket, with an IPv6 address reduced to its /64, as the sign-in failure limits already were. Before, rotating the low 64 bits of an IPv6 address gave a fresh anonymous read budget.

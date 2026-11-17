---
'@korajs/auth': patch
---

`ExternalJwtProvider` with `jwtSecret` now accepts any standard HS256 token header: one with a `kid` (Supabase includes one), one without `typ`, or one with its keys in another order. It used to accept only the exact bytes of `{"alg":"HS256","typ":"JWT"}` and refused those tokens. `alg: "none"`, every other algorithm, `crit`, and a `typ` other than JWT or `at+jwt` are still refused. Kora's own tokens keep the exact check. Asymmetric keys still need `validateToken`.

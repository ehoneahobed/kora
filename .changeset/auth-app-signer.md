---
'@korajs/auth': patch
---

`createAppSigner(authSecretFromEnv(), purpose)` from `@korajs/auth/server` signs the small values an app hands out (share links, invitations, unsubscribe links) with the sign-in secret: tokens are signed with the current secret and accepted when signed with any secret still listed in `KORA_AUTH_SECRET_PREVIOUS`, so changing the secret doesn't break links already sent. Each purpose has its own key, and expiry is optional.

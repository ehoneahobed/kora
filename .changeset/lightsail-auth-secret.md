---
'@korajs/cli': patch
---

`kora deploy --platform=aws-lightsail` now forwards `KORA_AUTH_SECRET`, the name the template servers read. It used to forward only `AUTH_SECRET`, so a deploy that followed the docs ran with sign-in off. It also forwards `KORA_AUTH_SECRET_PREVIOUS`, the Google OAuth settings, the admin, backup and metrics tokens, and `KORA_TRUST_PROXY`. A legacy `AUTH_SECRET` is forwarded as `KORA_AUTH_SECRET`, with a warning. The docs use the new names.

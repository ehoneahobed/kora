---
"@korajs/cli": patch
---

`kora deploy --platform kora-cloud --prod --confirm` no longer asks for `--app` in a folder linked to a Kora Cloud project: the link says where it deploys. Failures print their message once; unexpected ones no longer print twice with a stack trace (set `KORA_DEBUG=1` to see it).

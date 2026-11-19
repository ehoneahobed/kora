---
'@korajs/svelte': patch
---

`docs/api/errors.md` lists the 46 error codes the docs check had missed, including `OFFLINE_PIN_LIMIT`, the auth and organization client codes, the read-through client codes, every `kora upgrade` code and the Playwright helper codes. The check now reads `new SomeError(message, 'CODE')` too. The Svelte README's setup snippet gains the `{:catch}` the template has.

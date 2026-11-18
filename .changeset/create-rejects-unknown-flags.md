---
'@korajs/cli': patch
'create-kora-app': patch
---

`create` now refuses an unknown `--template` or `--pm` value instead of quietly using the default. With `--yes`, a typo used to scaffold the default template. It exits 1 and names the valid values. `--framework` accepts only frameworks that ship templates (React, Vue and Svelte); `--framework solid` used to pass validation and then fail with an uncaught error.

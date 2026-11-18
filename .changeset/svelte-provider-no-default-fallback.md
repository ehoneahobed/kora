---
'@korajs/svelte': patch
---

`KoraProvider` with `waitForStorage` and no `fallback` now renders nothing until the store opens, as React and Vue do. It used to render a `<div>Loading...</div>`. To keep a loading message, pass a `fallback` snippet.

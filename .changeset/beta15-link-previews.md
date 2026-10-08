---
"@korajs/server": minor
---

Shared links preview the page they point at. New `shellMeta` option on `createProductionServer` writes each URL's title, description and Open Graph tags into the app shell (values escaped; `null` or a throw serves the shell unchanged), with `applyShellMeta` and `metaExcerpt` exported. Link-preview crawlers and search engines asking for `*/*` now get the shell for extensionless app routes instead of a 404 (an app's own `fetch()` and paths under `/api/` and `/__kora` keep real 404s; `spaFallback: 'strict'` restores the beta.14 behavior). Custom routes may answer `html` or `raw` bytes as well as JSON.

---
"@korajs/cli": patch
---

The offline app shell opens a folder's precached `index.html` for a path ending in `/`, as a static host does. A help page shipped in `public/help/index.html` and linked as `/help/` now opens offline, instead of the app.

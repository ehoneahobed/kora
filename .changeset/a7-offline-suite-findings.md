---
"@korajs/cli": patch
"@korajs/vue": patch
---

Two bugs found by running every bundled template through the new offline-readiness suite (`pnpm test:e2e:offline`):

- `koraServiceWorker()`: the generated worker looked up its precache with `Vary` taken into account. A host that sends `Vary: Origin` (`vite preview`, and CDNs with CORS rules) made the page's own `<script type="module" crossorigin>` requests miss the install-time copies, so a reload of an app that reported `ready` failed offline with the shell blank. Lookups now ignore `Vary` (every precached URL is exactly one file of the build), and the cache check the status reads uses the same rule.
- `@korajs/vue` `KoraProvider` held the store in a deep `ref`, handing every composable a reactive Proxy of it. The store compares its query subscriptions by identity, so the first result of every `useQuery` was discarded as stale: after a reload the list stayed empty until the next write. It now uses `shallowRef`.

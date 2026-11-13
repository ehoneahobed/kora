---
"@korajs/cli": patch
---

`kora doctor` no longer warns about things that aren't problems, found by running it on Bozoma Learn:

- **One schema:** once the app's schema has loaded, only definitions that repeat its collections are reported. A self-contained script or test harness with its own throwaway schema is no longer flagged.
- **Runtime storage:** an adapter chosen in one branch of a conditional (`backend === 'indexeddb' ? { adapter: 'indexeddb' } : {}`, to reopen a fallback copy) no longer counts as the app forcing that adapter, so the worker and WASM delivery check still runs.
- **Insecure sync URL:** only sync settings (`SYNC_URL`, `syncUrl`, `sync:`, a bare `url:`) are read as sync endpoints, not other settings ending in URL (`KORA_BLOB_STORE_URL`, `PUBLIC_URL`), and reserved test hosts (`*.example`, `*.invalid`, `*.localhost`) are skipped.

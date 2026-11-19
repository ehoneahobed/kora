---
'korajs': patch
'@korajs/sync': patch
---

Read-through first visits are faster on slow links. The first screen's reads now go out from the first paint, without waiting for the answers code to download, which saves a round trip. A navigation's read that is still waiting for its answer now holds back the store's storage downloads for at most a second, instead of sharing the link with them. `@korajs/sync/read` also exports the `ReadRequest` type.

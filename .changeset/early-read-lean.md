---
'korajs': patch
---

The first-paint read-through code is smaller. The early read sends one request, for the first screen's queries. It's skipped for apps with `sync.authClient`, because asking a lazily loaded sign-in client for its session would download it during the first paint. The read tracker moves into the answers chunk.

---
'@korajs/server': patch
---

The custom route body deadline now stays within what a timer can wait, 2³¹−1 ms (about 24.8 days). A `routeBodyTimeoutMs` above that throws `INVALID_SERVER_CONFIG`, and the default is capped there for a huge `maxRequestBodyBytes`. Before, such a value made Node fire the timer at once, so every body was answered 408.
